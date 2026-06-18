import { and, eq, inArray, ne } from "drizzle-orm";
import { checkBranchTipIsAncestor, countUniqueCommits, isAncestor, revParse } from "@agentic-kanban/shared/lib/git-service";
import { issues, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { TERMINAL_STATUS_NAMES } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { logBoardHealthEvent } from "../repositories/board-health-events.repository.js";
import { closeWorkspace } from "../services/workspace-lifecycle-reconcile.service.js";

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
}

export interface TerminalWorkspaceReapResult {
  scanned: number;
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
    return { safe: false, reason: "git-error", message: err instanceof Error ? err.message : String(err) };
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

  const result: TerminalWorkspaceReapResult = { scanned: candidates.length, reaped: 0, skippedAhead: 0, skippedRunning: 0 };
  const now = new Date().toISOString();

  for (const c of candidates) {
    if (result.reaped >= maxReapedPerRun) break;

    if (await hasRunningSession(database, c.wsId)) {
      result.skippedRunning++;
      continue;
    }

    const verification = await verifyNoAheadWork(c, gitDeps);
    if (!verification.safe) {
      if (verification.reason === "ahead") {
        result.skippedAhead++;
        console.warn(
          `[terminal-workspace-reaper] refusing to close workspace ${c.wsId} for issue #${c.issueNumber ?? "?"}: ` +
            `${verification.aheadCommits ?? "unknown"} commit(s) are ahead of ${c.baseBranch ?? c.defaultBranch ?? "base"}`,
        );
      } else {
        console.warn(
          `[terminal-workspace-reaper] skipping workspace ${c.wsId} for issue #${c.issueNumber ?? "?"}: ${verification.message ?? verification.reason}`,
        );
      }
      continue;
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
      console.warn(`[terminal-workspace-reaper] failed to close workspace ${c.wsId}:`, err instanceof Error ? err.message : String(err));
    }
  }

  return result;
}

let activeTerminalReaperTimeout: ReturnType<typeof setTimeout> | null = null;
let activeTerminalReaperInterval: ReturnType<typeof setInterval> | null = null;

export function stopTerminalWorkspaceReaper(): void {
  if (activeTerminalReaperTimeout !== null) {
    clearTimeout(activeTerminalReaperTimeout);
    activeTerminalReaperTimeout = null;
  }
  if (activeTerminalReaperInterval !== null) {
    clearInterval(activeTerminalReaperInterval);
    activeTerminalReaperInterval = null;
  }
}

export function startTerminalWorkspaceReaper(
  deps: Omit<TerminalWorkspaceReaperDeps, "maxReapedPerRun"> = {},
  intervalMs = DEFAULT_INTERVAL_MS,
): { timer: NodeJS.Timeout; interval: NodeJS.Timeout } {
  stopTerminalWorkspaceReaper();

  const tick = deps.onTick ?? (() => {
    reapTerminalWorkspaces(deps).catch((err) =>
      console.warn("[terminal-workspace-reaper] periodic tick error:", err instanceof Error ? err.message : err),
    );
  });
  const timer = setTimeout(tick, 45_000);
  const interval = setInterval(tick, intervalMs);
  activeTerminalReaperTimeout = timer;
  activeTerminalReaperInterval = interval;
  (timer as NodeJS.Timeout).unref?.();
  (interval as NodeJS.Timeout).unref?.();
  return { timer, interval };
}
