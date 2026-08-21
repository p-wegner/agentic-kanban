import { existsSync } from "node:fs";
import { and, eq, inArray, ne } from "drizzle-orm";
import { checkBranchTipIsAncestor, countUniqueCommits, isAncestor, revParse } from "@agentic-kanban/shared/lib/git-service";
import { issues, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { TERMINAL_STATUS_NAMES } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { logBoardHealthEvent } from "../repositories/board-health-events.repository.js";
import { closeWorkspace } from "../services/workspace-lifecycle-reconcile.service.js";
import { listWorkspaceRepos, type RepoRow } from "../repositories/repo.repository.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import { emptyPassReport, formatPassReportBody, recordActed, recordSkipped, type PassReport } from "../lib/pass-report.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";

const REAPABLE_WORKSPACE_STATUSES = ["idle", "reviewing", "blocked"];
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface TerminalWorkspaceReaperDeps {
  database?: Database;
  checkAncestor?: typeof checkBranchTipIsAncestor;
  countCommits?: typeof countUniqueCommits;
  isAncestorRef?: typeof isAncestor;
  revParseRef?: typeof revParse;
  maxReapedPerRun?: number;
  onTick?: () => void;
  /**
   * On-disk presence probe for sibling repo paths (#277). Defaults to `existsSync`;
   * suites driving fake git over synthetic paths inject `() => true`.
   */
  pathExists?: (path: string) => boolean;
}

/**
 * #592 — the shared pass core, plus this pass's own counters. `scanned` now comes from
 * `PassReport`; `reaped`/`skippedAhead`/`skippedRunning` stay because callers and tests
 * read them by name.
 */
export interface TerminalWorkspaceReapResult extends PassReport {
  reaped: number;
  skippedAhead: number;
  skippedRunning: number;
}

type Candidate = {
  wsId: string;
  issueId: string;
  issueNumber: number | null;
  projectId: string;
  statusName: string;
  wsStatus: string;
  branch: string;
  baseBranch: string | null;
  defaultBranch: string | null;
  workingDir: string | null;
  repoPath: string;
  mergedAt: string | null;
  mergedHeadSha: string | null;
};

type Verification =
  | { safe: true; reason: "ancestor" | "zero-ahead"; branchSha: string; baseSha: string; markMerged: boolean }
  | { safe: false; reason: "ahead" | "missing-ref" | "git-error"; aheadCommits?: number; message?: string };

/**
 * List sibling repos of a multi-repo workspace that still have unmerged commits
 * (branch ahead of its base, not yet stamped mergedHeadSha) — a no-op ([]) for a
 * single-repo workspace. `verifyNoAheadWork` only judges the LEADING repo, so a
 * multi-repo workspace could otherwise be reaped closed while sibling commits sit
 * orphaned with nothing surfacing that fact (#153). Best-effort: any git error
 * resolving a row is treated as "nothing to report" here (unlike the fail-closed
 * `listPendingSiblingMerges` used on the merge path) since the reaper's worst case
 * on a false negative is a missed comment, not data loss — the workspace row stays
 * closed either way and the worktree is never removed by this path.
 */
async function findUnmergedSiblingBranches(
  workspaceId: string,
  database: Database,
  deps: {
    countCommits: typeof countUniqueCommits;
    revParseRef: typeof revParse;
    /**
     * On-disk presence probe for a sibling repo (#277). Defaults to `existsSync`;
     * suites using synthetic repo paths inject `() => true`.
     */
    pathExists?: (path: string) => boolean;
  },
): Promise<Array<{ label: string; branch: string; ahead: number }>> {
  const pathExists = deps.pathExists ?? existsSync;
  let rows: RepoRow[];
  try {
    rows = await listWorkspaceRepos(workspaceId, database);
  } catch {
    return [];
  }
  const unmerged: Array<{ label: string; branch: string; ahead: number }> = [];
  for (const repo of rows) {
    if (repo.mergedHeadSha) continue;
    if (!repo.branch || !repo.baseBranch) continue;
    // Repo directory gone → both revParse calls below would spawn git only to fail.
    // Same outcome ("nothing to report"), two fewer ~120ms event-loop stalls per
    // repo per cycle (#277).
    if (!pathExists(repo.path)) continue;
    try {
      await deps.revParseRef(repo.path, repo.baseBranch);
      await deps.revParseRef(repo.path, repo.branch);
    } catch {
      continue; // ref unresolvable — already cleaned up or repo gone, nothing to report
    }
    const ahead = await deps.countCommits(repo.path, repo.baseBranch, repo.branch).catch(() => 0);
    if (ahead > 0) {
      unmerged.push({ label: repo.name ?? repo.path, branch: repo.branch, ahead });
    }
  }
  return unmerged;
}

async function hasRunningSession(database: Database, workspaceId: string): Promise<boolean> {
  const rows = await database
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.status, "running")))
    .limit(1);
  return rows.length > 0;
}

async function verifyNoAheadWork(
  c: Candidate,
  deps: Required<Pick<TerminalWorkspaceReaperDeps, "checkAncestor" | "countCommits" | "isAncestorRef" | "revParseRef">>,
): Promise<Verification> {
  const baseBranch = c.baseBranch ?? c.defaultBranch;
  if (!baseBranch) return { safe: false, reason: "missing-ref", message: "missing base branch" };

  try {
    const ancestry = await deps.checkAncestor(c.repoPath, c.branch, baseBranch, c.workingDir ?? undefined);
    if (ancestry.isAncestor) {
      return { safe: true, reason: "ancestor", branchSha: ancestry.branchSha, baseSha: ancestry.baseSha, markMerged: true };
    }

    if (ancestry.branchSha) {
      const aheadCommits = await deps.countCommits(c.repoPath, ancestry.baseSha, ancestry.branchSha).catch(() => 1);
      if (aheadCommits > 0) return { safe: false, reason: "ahead", aheadCommits };
      return { safe: true, reason: "zero-ahead", branchSha: ancestry.branchSha, baseSha: ancestry.baseSha, markMerged: Boolean(c.mergedAt) };
    }

    if (c.mergedHeadSha) {
      const baseSha = await deps.revParseRef(c.repoPath, baseBranch);
      const mergedHeadIsAncestor = await deps.isAncestorRef(c.repoPath, c.mergedHeadSha, baseBranch);
      if (mergedHeadIsAncestor) {
        return { safe: true, reason: "ancestor", branchSha: c.mergedHeadSha, baseSha, markMerged: true };
      }
      const aheadCommits = await deps.countCommits(c.repoPath, baseSha, c.mergedHeadSha).catch(() => 1);
      if (aheadCommits > 0) return { safe: false, reason: "ahead", aheadCommits };
      return { safe: true, reason: "zero-ahead", branchSha: c.mergedHeadSha, baseSha, markMerged: Boolean(c.mergedAt) };
    }

    return { safe: false, reason: "missing-ref", message: ancestry.branchSha === null ? ancestry.reason : "branch is not an ancestor" };
  } catch (err) {
    return { safe: false, reason: "git-error", message: errorMessage(err) };
  }
}

/**
 * Close stale workspace rows for issues that are already terminal, but only
 * after git proves the workspace cannot contain unmerged commits ahead of base.
 */
export async function reapTerminalWorkspaces(
  deps: TerminalWorkspaceReaperDeps = {},
): Promise<TerminalWorkspaceReapResult> {
  const database = deps.database ?? db;
  const maxReapedPerRun = deps.maxReapedPerRun ?? 1;
  const gitDeps = {
    checkAncestor: deps.checkAncestor ?? checkBranchTipIsAncestor,
    countCommits: deps.countCommits ?? countUniqueCommits,
    isAncestorRef: deps.isAncestorRef ?? isAncestor,
    revParseRef: deps.revParseRef ?? revParse,
    pathExists: deps.pathExists ?? existsSync,
  };

  const candidates = await database
    .select({
      wsId: workspaces.id,
      issueId: issues.id,
      issueNumber: issues.issueNumber,
      projectId: issues.projectId,
      statusName: projectStatuses.name,
      wsStatus: workspaces.status,
      branch: workspaces.branch,
      baseBranch: workspaces.baseBranch,
      defaultBranch: projects.defaultBranch,
      workingDir: workspaces.workingDir,
      repoPath: projects.repoPath,
      mergedAt: workspaces.mergedAt,
      mergedHeadSha: workspaces.mergedHeadSha,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .where(
      and(
        eq(workspaces.isDirect, false),
        ne(workspaces.status, "closed"),
        inArray(workspaces.status, REAPABLE_WORKSPACE_STATUSES),
        inArray(projectStatuses.name, [...TERMINAL_STATUS_NAMES]),
      ),
    );

  const result: TerminalWorkspaceReapResult = { ...emptyPassReport(candidates.length), reaped: 0, skippedAhead: 0, skippedRunning: 0 };
  const now = new Date().toISOString();

  for (const c of candidates) {
    if (result.reaped >= maxReapedPerRun) break;

    if (await hasRunningSession(database, c.wsId)) {
      result.skippedRunning++;
      recordSkipped(result, c.wsId, "session running");
      continue;
    }

    const verification = await verifyNoAheadWork(c, gitDeps);
    if (!verification.safe) {
      if (verification.reason === "ahead") {
        result.skippedAhead++;
        recordSkipped(result, c.wsId, "ahead of base");
        console.warn(
          `[terminal-workspace-reaper] refusing to close workspace ${c.wsId} for issue #${c.issueNumber ?? "?"}: ` +
            `${verification.aheadCommits ?? "unknown"} commit(s) are ahead of ${c.baseBranch ?? c.defaultBranch ?? "base"}`,
        );
      } else {
        recordSkipped(result, c.wsId, verification.reason);
        console.warn(
          `[terminal-workspace-reaper] skipping workspace ${c.wsId} for issue #${c.issueNumber ?? "?"}: ${verification.message ?? verification.reason}`,
        );
      }
      continue;
    }

    // Multi-repo audit (#153): the ancestry verification above only judges the
    // LEADING repo. A sibling repo can still hold unmerged commits at reap time —
    // this workspace row is being closed (issue already terminal) without ever
    // running the sibling merge/cleanup pipeline, so those commits would otherwise
    // strand invisibly. clearWorkingDir stays false below (worktrees are left
    // alone), so nothing is destroyed here; at minimum, surface it as a comment.
    const unmergedSiblings = await findUnmergedSiblingBranches(c.wsId, database, gitDeps);
    if (unmergedSiblings.length > 0) {
      console.warn(
        `[terminal-workspace-reaper] closing workspace ${c.wsId} for terminal issue #${c.issueNumber ?? "?"} with ${unmergedSiblings.length} sibling repo(s) still unmerged: ` +
          unmergedSiblings.map((s) => `${s.label} (${s.branch}, ${s.ahead} ahead)`).join(", "),
      );
      try {
        await insertIssueComment({
          issueId: c.issueId,
          workspaceId: c.wsId,
          kind: "note",
          author: "system",
          body: `Closed stale ${c.wsStatus} workspace for terminal issue #${c.issueNumber ?? "?"}, but ${unmergedSiblings.length} sibling repo(s) still have unmerged commits and were left untouched:\n` +
            unmergedSiblings.map((s) => `- ${s.label} (${s.branch}): ${s.ahead} unmerged commit(s)`).join("\n"),
          payload: { unmergedSiblings, reapedAt: now },
          createdAt: now,
        }, database);
      } catch (err) {
        console.warn(`[terminal-workspace-reaper] failed to record unmerged-sibling comment for ${c.wsId}:`, errorMessage(err));
      }
    }

    try {
      await closeWorkspace({
        database,
        workspaceId: c.wsId,
        now,
        closedAt: now,
        mergedAt: c.mergedAt ?? now,
        markMerged: verification.markMerged,
        clearWorkingDir: false,
      });
      result.reaped++;
      recordActed(result, c.wsId, "reaped");
      console.log(
        `[terminal-workspace-reaper] closed stale ${c.wsStatus} workspace ${c.wsId} for terminal issue ` +
          `#${c.issueNumber ?? "?"} (${c.statusName}); reason=${verification.reason} branch=${c.branch}`,
      );
      try {
        await logBoardHealthEvent({
          projectId: c.projectId,
          cycleId: `terminal-workspace-reap-${c.wsId}`,
          eventType: "action",
          category: "merge",
          issueNumber: c.issueNumber ?? undefined,
          summary: `Closed stale ${c.wsStatus} workspace row for terminal issue #${c.issueNumber ?? "?"} after git verified no ahead work.`,
          details: {
            workspaceId: c.wsId,
            branch: c.branch,
            baseBranch: c.baseBranch ?? c.defaultBranch,
            branchSha: verification.branchSha,
            baseSha: verification.baseSha,
            reason: verification.reason,
            reapedAt: now,
          },
        }, database);
      } catch { /* health event logging is non-fatal */ }
    } catch (err) {
      console.warn(`[terminal-workspace-reaper] failed to close workspace ${c.wsId}:`, errorMessage(err));
    }
  }

  // #689: a failed close above (caught, warned, but recorded as neither reaped nor
  // skipped) and a candidate never reached because of `maxReapedPerRun` both belong in
  // the unaccounted remainder — this line is what makes either visible instead of only
  // the per-row logs above. The tag is a literal first argument on purpose (#616).
  console.log(`[terminal-workspace-reaper] ${formatPassReportBody(result)}`);
  return result;
}

let activeTerminalReaperSweep: PeriodicSweepHandle | null = null;

export function stopTerminalWorkspaceReaper(): void {
  activeTerminalReaperSweep?.stop();
  activeTerminalReaperSweep = null;
}

export function startTerminalWorkspaceReaper(
  deps: Omit<TerminalWorkspaceReaperDeps, "maxReapedPerRun"> = {},
  intervalMs = DEFAULT_INTERVAL_MS,
): PeriodicSweepHandle {
  stopTerminalWorkspaceReaper();
  activeTerminalReaperSweep = startPeriodicSweep({
    name: "terminal-workspace-reaper",
    // `onTick` is the test seam — it replaces the sweep, not just its logging.
    tick: deps.onTick ?? (() => reapTerminalWorkspaces(deps)),
    bootDelayMs: 45_000,
    intervalMs,
  });
  return activeTerminalReaperSweep;
}

