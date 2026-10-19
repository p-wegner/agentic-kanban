import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, and, gte } from "drizzle-orm";
import { parseSessionSummary } from "@agentic-kanban/shared";
import { getCommitsForBranch } from "../git-service.js";
import { prodDeps, type ToolDeps } from "./deps.js";
import { mcpJson, mcpText, resolveActiveProjectId } from "../db-utils.js";
// Session-role classification is the shared traits table (#495) — this file used to
// carry a byte-identical private copy of it.
import { triggerRole as classifyTrigger } from "@agentic-kanban/shared/lib/session-trigger";

/**
 * Mirrors `pnpm cli -- session reviewer-fixes`.
 * Measures how often the code-review agent fixes findings itself (and commits)
 * vs only approving. Two methods:
 *  • git  — attributes each branch commit (author date) to the session that was
 *            running when it was authored; a commit landing inside a review
 *            session's window == the reviewer committed a fix.
 *  • deep — parses each review transcript for code edits + git commits (slower).
 */

type Sess = { id: string; kind: ReturnType<typeof classifyTrigger>; start: number; end: number };
type WS = {
  workspaceId: string;
  issueNumber: number;
  issueTitle: string;
  provider: string | null;
  wsStatus: string;
  merged: boolean;
  baseCommitSha: string | null;
  headRef: string | null;
  sessions: Sess[];
  hasReview: boolean;
};
type Result = {
  issue: number;
  title: string;
  provider: string | null;
  merged: boolean;
  wsStatus: string;
  gitResolved: boolean;
  implementerCommits: number;
  reviewerCommits: number;
  reviewerCommitsNamingIssue: number;
  reworkCommits: number;
  unattributedCommits: number;
  reviewerCommitSubjects: string[];
  reviewSessionIds: string[];
  reviewEdited?: boolean;
  reviewCommitted?: boolean;
};

const GRACE_MS = 2 * 60 * 1000;

async function fetchSessionRows(deps: ToolDeps, pid: string, sinceIso: string) {
  const { db, schema } = deps;
  return db
    .select({
      sessionId: schema.sessions.id,
      triggerType: schema.sessions.triggerType,
      executor: schema.sessions.executor,
      startedAt: schema.sessions.startedAt,
      endedAt: schema.sessions.endedAt,
      workspaceId: schema.workspaces.id,
      branch: schema.workspaces.branch,
      wsStatus: schema.workspaces.status,
      provider: schema.workspaces.provider,
      baseCommitSha: schema.workspaces.baseCommitSha,
      mergedHeadSha: schema.workspaces.mergedHeadSha,
      mergedAt: schema.workspaces.mergedAt,
      issueNumber: schema.issues.issueNumber,
      issueTitle: schema.issues.title,
    })
    .from(schema.sessions)
    .innerJoin(schema.workspaces, eq(schema.sessions.workspaceId, schema.workspaces.id))
    .innerJoin(schema.issues, eq(schema.workspaces.issueId, schema.issues.id))
    .where(and(eq(schema.issues.projectId, pid), gte(schema.sessions.startedAt, sinceIso)))
    .orderBy(schema.sessions.startedAt);
}

type SessionRow = Awaited<ReturnType<typeof fetchSessionRows>>[number];

function newWorkspaceEntry(r: SessionRow): WS {
  return {
    workspaceId: r.workspaceId,
    issueNumber: r.issueNumber ?? 0,
    issueTitle: r.issueTitle,
    provider: r.provider,
    wsStatus: r.wsStatus,
    merged: !!r.mergedAt,
    baseCommitSha: r.baseCommitSha,
    headRef: r.mergedHeadSha ?? r.branch,
    sessions: [],
    hasReview: false,
  };
}

function groupByWorkspace(rows: SessionRow[], nowMs: number): Map<string, WS> {
  const byWs = new Map<string, WS>();
  for (const r of rows) {
    const kind = classifyTrigger(r.triggerType);
    if (kind === "noise") continue;
    let ws = byWs.get(r.workspaceId);
    if (!ws) {
      ws = newWorkspaceEntry(r);
      byWs.set(r.workspaceId, ws);
    }
    if (kind === "review") ws.hasReview = true;
    ws.sessions.push({
      id: r.sessionId,
      kind,
      start: new Date(r.startedAt).getTime(),
      end: r.endedAt ? new Date(r.endedAt).getTime() : nowMs,
    });
  }
  // Close open-ended session windows
  for (const ws of byWs.values()) {
    ws.sessions.sort((a, b) => a.start - b.start);
    for (let i = 0; i < ws.sessions.length - 1; i++) {
      const next = ws.sessions[i + 1].start;
      if (ws.sessions[i].end > next) ws.sessions[i].end = next;
    }
  }
  return byWs;
}

// Strict commit attribution
function attribute(commitDateIso: string, sessions: Sess[]): Sess | null {
  const t = new Date(commitDateIso).getTime();
  if (!Number.isFinite(t)) return null;
  for (const s of sessions) {
    if (t >= s.start && t <= s.end + GRACE_MS) return s;
  }
  return null;
}

function namesIssue(msg: string, issueNumber: number): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes(`#${issueNumber}`) ||
    m.includes(`ak-${issueNumber}`) ||
    m.includes(`(${issueNumber})`)
  );
}

function emptyResult(ws: WS, commitCount: number): Result {
  return {
    issue: ws.issueNumber,
    title: ws.issueTitle.slice(0, 48),
    provider: ws.provider,
    merged: ws.merged,
    wsStatus: ws.wsStatus,
    gitResolved: commitCount > 0,
    implementerCommits: 0,
    reviewerCommits: 0,
    reviewerCommitsNamingIssue: 0,
    reworkCommits: 0,
    unattributedCommits: 0,
    reviewerCommitSubjects: [],
    reviewSessionIds: ws.sessions.filter((s) => s.kind === "review").map((s) => s.id),
  };
}

function countCommit(res: Result, ws: WS, c: { date: string; message: string }): void {
  const kind = attribute(c.date, ws.sessions)?.kind ?? null;
  if (kind === "review") {
    res.reviewerCommits++;
    if (namesIssue(c.message, ws.issueNumber)) res.reviewerCommitsNamingIssue++;
    if (res.reviewerCommitSubjects.length < 5) res.reviewerCommitSubjects.push(c.message.slice(0, 60));
  } else if (kind === "rework") res.reworkCommits++;
  else if (kind === "build") res.implementerCommits++;
  else res.unattributedCommits++;
}

async function analyzeWorkspace(repoPath: string, ws: WS): Promise<Result> {
  const commits =
    ws.baseCommitSha && ws.headRef
      ? await getCommitsForBranch(repoPath, ws.baseCommitSha, ws.headRef)
      : [];
  const res = emptyResult(ws, commits.length);
  for (const c of commits) countCommit(res, ws, c);
  return res;
}

async function applyDeepPass(deps: ToolDeps, results: Result[]): Promise<void> {
  const { db, schema } = deps;
  for (const res of results) {
    let edited = false, committed = false;
    for (const sid of res.reviewSessionIds) {
      const msgRows = await db
        .select({ type: schema.sessionMessages.type, data: schema.sessionMessages.data })
        .from(schema.sessionMessages)
        .where(eq(schema.sessionMessages.sessionId, sid))
        .orderBy(schema.sessionMessages.id);
      const summary = parseSessionSummary(msgRows) as unknown as {
        filesEdited?: string[];
        filesWritten?: string[];
        commandsRun?: string[];
      };
      if ((summary.filesEdited?.length ?? 0) > 0 || (summary.filesWritten?.length ?? 0) > 0)
        edited = true;
      if ((summary.commandsRun ?? []).some((cmd) => /git\s+commit/i.test(cmd)))
        committed = true;
    }
    res.reviewEdited = edited;
    res.reviewCommitted = committed;
  }
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const sumBy = (results: Result[], pick: (r: Result) => number) => results.reduce((s, r) => s + pick(r), 0);

function buildGitMethod(results: Result[], gitResolved: Result[]) {
  const reviewerCommittedWs = gitResolved.filter((r) => r.reviewerCommits > 0);
  const highConfWs = gitResolved.filter((r) => r.reviewerCommitsNamingIssue > 0);
  return {
    caveat:
      "APPROXIMATE / lower bound. base..mergedHeadSha is polluted by the board's pre-merge rebases. Use --deep (transcript) as the source of truth.",
    workspacesWhereReviewerCommitted: reviewerCommittedWs.length,
    pctOfGitResolvedWhereReviewerCommitted: pct(reviewerCommittedWs.length, gitResolved.length),
    highConfidenceReviewerFixes: highConfWs.length,
    pctOfGitResolvedHighConfidence: pct(highConfWs.length, gitResolved.length),
    totalReviewerCommits: sumBy(results, (r) => r.reviewerCommits),
    totalImplementerCommits: sumBy(results, (r) => r.implementerCommits),
    totalReworkCommits: sumBy(results, (r) => r.reworkCommits),
    reviewerFixesThatMerged: reviewerCommittedWs.filter((r) => r.merged).length,
  };
}

function addDeepSections(report: Record<string, unknown>, results: Result[]): void {
  const fixedBySession = (r: Result) => !!(r.reviewEdited || r.reviewCommitted);
  const reviewEdited = results.filter((r) => r.reviewEdited);
  const bothAgreeFix = results.filter((r) => r.reviewerCommits > 0 && fixedBySession(r)).length;
  const gitOnly = results.filter((r) => r.reviewerCommits > 0 && !fixedBySession(r)).length;
  const sessionOnly = results.filter((r) => r.reviewerCommits === 0 && fixedBySession(r)).length;
  report.deepMethod = {
    reviewsThatEditedCode: reviewEdited.length,
  };
  report.methodAgreement = { bothAgreeReviewerFixed: bothAgreeFix, gitOnly, sessionTranscriptOnly: sessionOnly };
}

function perWorkspaceRows(results: Result[], deep: boolean | undefined) {
  return results.map((r) => ({
    issue: r.issue,
    title: r.title,
    provider: r.provider,
    implCommits: r.implementerCommits,
    reviewerCommits: r.reviewerCommits,
    reviewerCommitsNamingIssue: r.reviewerCommitsNamingIssue,
    reworkCommits: r.reworkCommits,
    merged: r.merged,
    ...(deep ? { reviewEdited: r.reviewEdited, reviewCommitted: r.reviewCommitted } : {}),
    reviewerCommitSubjects: r.reviewerCommitSubjects,
  }));
}

export function registerReviewerFixes(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;

  server.tool(
    "reviewer_fixes",
    "Measure how often the code-review agent FIXES findings itself (and commits) vs only approving. Two methods: git (commit author-time inside a review session's window) and deep transcript analysis (--deep). Mirrors `pnpm cli -- session reviewer-fixes`.",
    {
      days: z.number().optional().describe("Window size in days (default: 14)"),
      projectId: z.string().optional().describe("Project ID (defaults to active project)"),
      limit: z.number().int().optional().describe("Cap the number of reviewed workspaces inspected (0 = all, default: 0)"),
      deep: z.boolean().optional().describe("Also parse review transcripts for edits/commits (slower)"),
    },
    async ({ days, projectId, limit, deep }) => {
      const windowDays = Math.max(1, days ?? 14);
      const capLimit = Math.max(0, limit ?? 0);
      const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

      // Resolve projectId
      const rpid = await resolveActiveProjectId(db, schema, projectId);
      if (!rpid.ok) return rpid.error;
      const pid = rpid.projectId;

      // Project repoPath
      const projRows = await db
        .select({ repoPath: schema.projects.repoPath })
        .from(schema.projects)
        .where(eq(schema.projects.id, pid))
        .limit(1);
      const repoPath = projRows[0]?.repoPath;
      if (!repoPath) {
        return mcpText(`Project '${pid}' has no repoPath.`);
      }

      const rows = await fetchSessionRows(deps, pid, sinceIso);
      const byWs = groupByWorkspace(rows, Date.now());

      let targets = [...byWs.values()].filter((w) => w.hasReview);
      targets.sort((a, b) => a.issueNumber - b.issueNumber);
      const gitEligible = targets.filter((w) => w.baseCommitSha && w.headRef).length;
      if (capLimit > 0) targets = targets.slice(0, capLimit);

      const results: Result[] = [];
      for (const ws of targets) results.push(await analyzeWorkspace(repoPath, ws));
      if (deep) await applyDeepPass(deps, results);

      const gitResolved = results.filter((r) => r.gitResolved);
      const report: Record<string, unknown> = {
        window: { days: windowDays, since: sinceIso, projectId: pid, repoPath },
        scope: {
          reviewedWorkspacesInWindow: [...byWs.values()].filter((w) => w.hasReview).length,
          inspected: results.length,
          gitEligible,
          gitHistoryResolved: gitResolved.length,
        },
        gitMethod: buildGitMethod(results, gitResolved),
      };
      if (deep) addDeepSections(report, results);
      report.perWorkspace = perWorkspaceRows(results, deep);

      return mcpJson(report);
    },
  );
}
