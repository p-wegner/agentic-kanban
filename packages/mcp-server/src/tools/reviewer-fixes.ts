import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, and, gte } from "drizzle-orm";
import { parseSessionSummary } from "@agentic-kanban/shared";
import { getCommitsForBranch } from "../git-service.js";
import { prodDeps, type ToolDeps } from "./deps.js";
import { resolveActiveProjectId } from "../db-utils.js";

/**
 * Mirrors `pnpm cli -- session reviewer-fixes`.
 * Measures how often the code-review agent fixes findings itself (and commits)
 * vs only approving. Two methods:
 *  • git  — attributes each branch commit (author date) to the session that was
 *            running when it was authored; a commit landing inside a review
 *            session's window == the reviewer committed a fix.
 *  • deep — parses each review transcript for code edits + git commits (slower).
 */
export function registerReviewerFixes(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;

  function classifyTrigger(t: string | null): "review" | "build" | "rework" | "noise" | "other" {
    if (!t) return "build";
    if (t === "review" || t.startsWith("skill:code-review")) return "review";
    if (t.startsWith("skill:board-monitor") || t.startsWith("skill:board-navigator")) return "noise";
    if (t === "chat" || t === "fix-and-merge" || t === "fix-conflicts" || t === "plan-reject") return "rework";
    if (t === "verify" || t === "learning" || t === "bisect" || t === "reconcile") return "other";
    return "build";
  }

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
      const GRACE_MS = 2 * 60 * 1000;

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
        return { content: [{ type: "text" as const, text: `Project '${pid}' has no repoPath.` }] };
      }

      // Fetch sessions in window
      const rows = await db
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

      const byWs = new Map<string, WS>();
      const nowMs = Date.now();

      for (const r of rows) {
        const kind = classifyTrigger(r.triggerType);
        if (kind === "noise") continue;
        let ws = byWs.get(r.workspaceId);
        if (!ws) {
          ws = {
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

      let targets = [...byWs.values()].filter((w) => w.hasReview);
      targets.sort((a, b) => a.issueNumber - b.issueNumber);
      const gitEligible = targets.filter((w) => w.baseCommitSha && w.headRef).length;
      if (capLimit > 0) targets = targets.slice(0, capLimit);

      // Strict commit attribution
      const attribute = (
        commitDateIso: string,
        sessions: Sess[],
      ): Sess | null => {
        const t = new Date(commitDateIso).getTime();
        if (!Number.isFinite(t)) return null;
        for (const s of sessions) {
          if (t >= s.start && t <= s.end + GRACE_MS) return s;
        }
        return null;
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
      const results: Result[] = [];

      for (const ws of targets) {
        const commits =
          ws.baseCommitSha && ws.headRef
            ? await getCommitsForBranch(repoPath, ws.baseCommitSha, ws.headRef)
            : [];
        const res: Result = {
          issue: ws.issueNumber,
          title: ws.issueTitle.slice(0, 48),
          provider: ws.provider,
          merged: ws.merged,
          wsStatus: ws.wsStatus,
          gitResolved: commits.length > 0,
          implementerCommits: 0,
          reviewerCommits: 0,
          reviewerCommitsNamingIssue: 0,
          reworkCommits: 0,
          unattributedCommits: 0,
          reviewerCommitSubjects: [],
          reviewSessionIds: ws.sessions.filter((s) => s.kind === "review").map((s) => s.id),
        };
        const namesIssue = (msg: string) => {
          const m = msg.toLowerCase();
          return (
            m.includes(`#${ws.issueNumber}`) ||
            m.includes(`ak-${ws.issueNumber}`) ||
            m.includes(`(${ws.issueNumber})`)
          );
        };
        for (const c of commits) {
          const s = attribute(c.date, ws.sessions);
          const kind = s?.kind ?? null;
          if (kind === "review") {
            res.reviewerCommits++;
            if (namesIssue(c.message)) res.reviewerCommitsNamingIssue++;
            if (res.reviewerCommitSubjects.length < 5)
              res.reviewerCommitSubjects.push(c.message.slice(0, 60));
          } else if (kind === "rework") res.reworkCommits++;
          else if (kind === "build") res.implementerCommits++;
          else res.unattributedCommits++;
        }
        results.push(res);
      }

      // Deep transcript pass
      if (deep) {
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
      const gitResolved = results.filter((r) => r.gitResolved);
      const reviewerCommittedWs = gitResolved.filter((r) => r.reviewerCommits > 0);
      const highConfWs = gitResolved.filter((r) => r.reviewerCommitsNamingIssue > 0);
      const totalReviewerCommits = results.reduce((s, r) => s + r.reviewerCommits, 0);
      const totalImplCommits = results.reduce((s, r) => s + r.implementerCommits, 0);
      const totalReworkCommits = results.reduce((s, r) => s + r.reworkCommits, 0);

      const report: Record<string, unknown> = {
        window: { days: windowDays, since: sinceIso, projectId: pid, repoPath },
        scope: {
          reviewedWorkspacesInWindow: [...byWs.values()].filter((w) => w.hasReview).length,
          inspected: results.length,
          gitEligible,
          gitHistoryResolved: gitResolved.length,
        },
        gitMethod: {
          caveat:
            "APPROXIMATE / lower bound. base..mergedHeadSha is polluted by the board's pre-merge rebases. Use --deep (transcript) as the source of truth.",
          workspacesWhereReviewerCommitted: reviewerCommittedWs.length,
          pctOfGitResolvedWhereReviewerCommitted: pct(reviewerCommittedWs.length, gitResolved.length),
          highConfidenceReviewerFixes: highConfWs.length,
          pctOfGitResolvedHighConfidence: pct(highConfWs.length, gitResolved.length),
          totalReviewerCommits,
          totalImplementerCommits: totalImplCommits,
          totalReworkCommits,
          reviewerFixesThatMerged: reviewerCommittedWs.filter((r) => r.merged).length,
        },
      };

      if (deep) {
        const reviewEdited = results.filter((r) => r.reviewEdited);
        const bothAgreeFix = results.filter(
          (r) => r.reviewerCommits > 0 && (r.reviewEdited || r.reviewCommitted),
        ).length;
        const gitOnly = results.filter(
          (r) => r.reviewerCommits > 0 && !(r.reviewEdited || r.reviewCommitted),
        ).length;
        const sessionOnly = results.filter(
          (r) => r.reviewerCommits === 0 && (r.reviewEdited || r.reviewCommitted),
        ).length;
        report.deepMethod = {
          reviewsThatEditedCode: reviewEdited.length,
        };
        report.methodAgreement = { bothAgreeReviewerFixed: bothAgreeFix, gitOnly, sessionTranscriptOnly: sessionOnly };
      }

      report.perWorkspace = results.map((r) => ({
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

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(report, null, 2),
        }],
      };
    },
  );
}
