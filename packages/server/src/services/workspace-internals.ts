import { workspaces } from "@agentic-kanban/shared/schema";
import type { WorkspaceSetupRun, WorkspaceSymlinkRun } from "@agentic-kanban/shared";
import type { ProviderName } from "./agent-provider.js";
import type { AgentSettings } from "./agent-settings.service.js";
import * as realGitService from "./git.service.js";

export class WorkspaceError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT",
    public readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function applyWorkspaceAgentSelection(
  settings: AgentSettings,
  workspace: typeof workspaces.$inferSelect,
): AgentSettings {
  const provider = workspace.provider;
  if (provider !== "claude" && provider !== "codex" && provider !== "copilot") return settings;

  const profileName = workspace.claudeProfile || undefined;
  const agentArgs = provider === "claude"
    ? settings.agentArgs
    : settings.agentArgs
      ?.split(/\s+/)
      .filter((arg) => arg && arg !== "--dangerously-skip-permissions")
      .join(" ") || undefined;
  return {
    ...settings,
    agentArgs,
    provider,
    claudeProfile: provider === "claude" ? profileName : undefined,
    profile: profileName ? { provider: provider as ProviderName, name: profileName } : undefined,
  };
}

export function requireBaseBranch(baseBranch: string | null | undefined): string {
  if (!baseBranch) {
    throw new WorkspaceError(
      "No default branch configured for this project. Set a default branch in project settings or choose a base branch.",
      "BAD_REQUEST",
    );
  }
  return baseBranch;
}

export type TurnResult =
  | { type: "sent" }
  | { type: "resumed"; sessionId: string };

export interface CreateWorkspaceInput {
  issueId: string;
  branch?: string;
  isDirect?: boolean;
  baseBranch?: string;
  requiresReview?: boolean;
  thoroughReview?: boolean;
  planMode?: boolean;
  tddMode?: boolean;
  includeVisualProof?: boolean;
  skipSetup?: boolean;
  customPrompt?: string;
  /** Markdown block of answered preflight clarifications, prepended to the agent's
   *  initial context so it starts with the resolved Q&A. */
  clarifications?: string;
  skillId?: string;
  /** Name of a disk-only skill (no DB entry) — used when id starts with "disk:" */
  skillName?: string;
  profile?: { provider?: string; name?: string };
  claudeProfile?: string;
  /** Claude model tier (e.g. "opus"). Falls back to the default_model preference when omitted. */
  model?: string;
  /** Skip the context-packer for lightweight tickets that don't need auto-context. */
  skipContextPacker?: boolean;
}

export interface CreateWorkspaceResult {
  id: string;
  issueId: string;
  branch: string;
  workingDir: string | null;
  baseBranch: string | null;
  isDirect: boolean;
  planMode: boolean;
  includeVisualProof: boolean;
  status: string;
  provider: ProviderName;
  latestSetup?: WorkspaceSetupRun;
  latestSymlink?: WorkspaceSymlinkRun;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

/** Subset of the git service that workspace services depend on. Injectable for tests. */
export type GitService = typeof realGitService;

// ─── Merge-resolution state machine ─────────────────────────────────────────

/**
 * Explicit outcomes from the merge pre-flight checks.
 *
 * `conflict-ready`  — conflicts exist; caller should invoke fix-and-merge.
 * `error-skip`      — a non-conflict error blocked the merge (dirty main, bad
 *                     branch state, stale build); caller should surface the
 *                     WorkspaceError and stop without launching fix-and-merge.
 * `proceed`         — all checks passed; caller should execute the git merge.
 * `reconcile`       — branch is already an ancestor (previously merged); caller
 *                     should mark Done without a git merge.
 * `already-merged`  — mergedAt already stamped (dropped-response retry); caller
 *                     should 409.
 * `direct-close`    — isDirect workspace; no git op, just close.
 */
export type MergeResolutionState =
  | { kind: "already-merged" }
  | { kind: "direct-close" }
  | { kind: "reconcile"; branchSha: string; baseSha: string; uniqueCommits: number }
  | { kind: "conflict-ready"; conflictFiles: string[]; behindCount?: number; error: WorkspaceError }
  | { kind: "error-skip"; error: WorkspaceError }
  | { kind: "proceed" };

export type ResolveMergeStateDeps = {
  gitService: GitService;
};

/**
 * Run the merge pre-flight state machine for a workspace.
 *
 * All decision branches that previously lived inline inside `doMerge` are
 * consolidated here so each path is independently testable without standing up
 * a full merge pipeline.
 */
export async function resolveMergeState(
  workspace: typeof workspaces.$inferSelect,
  repoPath: string,
  baseBranch: string,
  deps: ResolveMergeStateDeps,
): Promise<MergeResolutionState> {
  const { gitService } = deps;

  // mergedAt is stamped immediately after git merge lands (#575 crash-recovery guard).
  // If it's set, the merge already completed — run cleanup and move to Done without
  // another git merge, regardless of workspace.status.
  if (workspace.mergedAt) {
    return { kind: "already-merged" };
  }

  if (workspace.isDirect) {
    return { kind: "direct-close" };
  }

  // Branch-level checks require a non-null workingDir; skip cleanly if absent.
  if (workspace.workingDir) {
    // Ancestry check: if the branch tip is already reachable from the base, the work
    // was merged in a previous run that didn't update the DB.  Guard: require ≥1
    // unique commit so a 0-commit branch isn't mistakenly reconciled.
    const ancestryResult = await gitService.checkBranchTipIsAncestor(
      repoPath, workspace.branch, baseBranch, workspace.workingDir,
    );
    if (ancestryResult.isAncestor) {
      const { branchSha, baseSha } = ancestryResult;
      const uniqueCommits = await gitService.countUniqueCommits(repoPath, baseSha, branchSha).catch(() => 0);
      if (uniqueCommits > 0) {
        return { kind: "reconcile", branchSha, baseSha, uniqueCommits };
      }
    }

    // Dirty-main guard: main checkout must not have uncommitted tracked changes.
    if (typeof gitService.getUncommittedTrackedChanges === "function") {
      try {
        const uncommitted = await gitService.getUncommittedTrackedChanges(repoPath);
        if (uncommitted.length > 0) {
          return {
            kind: "error-skip",
            error: new WorkspaceError(
              `Main checkout has ${uncommitted.length} uncommitted tracked change(s) — commit or stash those changes first.`,
              "CONFLICT",
              { mergeReason: "dirty_main", uncommittedFiles: uncommitted },
            ),
          };
        }
      } catch (err) {
        if (err instanceof WorkspaceError) return { kind: "error-skip", error: err };
        // Non-fatal: getUncommittedTrackedChanges is a best-effort guard.
      }
    }

    // Behind-count: auto-rebase if the branch has fallen behind the base.
    let behindCount = 0;
    try {
      if (typeof gitService.countBehindCommits === "function") {
        behindCount = await gitService.countBehindCommits(repoPath, workspace.branch, baseBranch);
      }
    } catch {
      // Non-fatal — behind-count is advisory; proceed to conflict detection.
    }

    if (behindCount > 0) {
      const rebaseResult = await gitService.rebaseOntoBase(
        workspace.workingDir, baseBranch, workspace.branch, { preferLocalBase: true },
      );
      if (!rebaseResult.success) {
        const conflictFiles = rebaseResult.conflictingFiles ?? [];
        // Best-effort abort so the worktree is usable for fix-and-merge.
        try { await gitService.abortRebase(workspace.workingDir); } catch { /* best-effort */ }
        return {
          kind: "conflict-ready",
          conflictFiles,
          behindCount,
          error: new WorkspaceError(
            `Merge conflicts detected after auto-rebase (branch was ${behindCount} commit(s) behind ${baseBranch})`,
            "CONFLICT",
            { mergeReason: "conflict", conflictFiles, behindCount },
          ),
        };
      }
    }

    // Conflict detection: use read-only merge-tree against the (now up-to-date) branch.
    const conflicts = await gitService.detectConflicts(workspace.workingDir, baseBranch);
    if (conflicts.hasConflicts) {
      return {
        kind: "conflict-ready",
        conflictFiles: conflicts.conflictingFiles,
        error: new WorkspaceError(
          "Merge conflicts detected",
          "CONFLICT",
          { mergeReason: "conflict", conflictFiles: conflicts.conflictingFiles },
        ),
      };
    }
  }

  return { kind: "proceed" };
}

export const MERGE_LOCK_STALE_MS = 15 * 60 * 1000;

export interface ActiveMergeLock {
  promise: Promise<unknown>;
  workspaceId: string;
  repoPath: string;
  startedAt: string;
  startedAtMs: number;
}

/** Merge serialization: one active merge per repo at a time. Shared across services. */
export const activeMerges = new Map<string, ActiveMergeLock>();

export function describeMergeLock(lock: ActiveMergeLock, nowMs = Date.now()) {
  const ageMs = Math.max(0, nowMs - lock.startedAtMs);
  return {
    repoPath: lock.repoPath,
    activeWorkspaceId: lock.workspaceId,
    startedAt: lock.startedAt,
    ageMs,
    staleAfterMs: MERGE_LOCK_STALE_MS,
    isStale: ageMs > MERGE_LOCK_STALE_MS,
  };
}
