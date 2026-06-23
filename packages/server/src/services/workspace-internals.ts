import { workspaces } from "@agentic-kanban/shared/schema";
import type { WorkspaceSetupRun, WorkspaceSymlinkRun } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import type { ProviderName } from "./agent-provider.js";
import type { AgentSettings } from "./agent-settings.service.js";
import { loadProjectRuntimeConfig } from "./project-runtime-config.service.js";
import * as realGitService from "./git.service.js";
import { detectWorkspaceMergeConflicts } from "./workspace-merge-conflict.service.js";

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
  if (provider !== "claude" && provider !== "codex" && provider !== "copilot" && provider !== "pi") return settings;

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

/**
 * Resolve the agent selection for a *relaunched* session (fix-and-merge / conflict
 * resolver) honoring the board's CURRENT default rather than the provider baked
 * into the workspace record at original creation time (#762).
 *
 * A fresh-workspace POST resolves its provider from the Strategy Bullseye default
 * (`selectProviderFromStrategy`); a relaunch historically read only
 * `workspace.provider`, so after changing the board default, resolver sessions
 * still ran under the stale provider and needed a manual stop → PATCH → relaunch.
 *
 * This re-reads the current strategy default at launch time, the same fan-out the
 * POST uses. When no strategy default is configured (selection is `null`) it falls
 * back to the workspace's baked provider via `applyWorkspaceAgentSelection`, which
 * also preserves any provider explicitly pinned on the record.
 */
export async function resolveRelaunchAgentSelection(
  database: Database,
  projectId: string | null | undefined,
  workspace: typeof workspaces.$inferSelect,
  commandOverride?: string,
): Promise<AgentSettings> {
  const runtime = await loadProjectRuntimeConfig(database, {
    projectId: projectId ?? "",
    workspaceSelection: {
      provider: workspace.provider,
      profileName: workspace.claudeProfile,
    },
    commandOverride,
  });
  if (runtime.provider.source === "strategy") {
    console.log(`[relaunch] strategy provider selection: ${runtime.provider.provider}:${runtime.provider.profileName ?? ""} (workspace baked=${workspace.provider}:${workspace.claudeProfile})`);
  }

  return {
    agentCommand: runtime.provider.agentCommand,
    agentArgs: runtime.provider.agentArgs,
    claudeProfile: runtime.provider.provider === "claude" ? runtime.provider.profileName : undefined,
    profile: runtime.provider.profileSelection,
    provider: runtime.provider.provider,
    resumeWithNewModel: runtime.provider.resumeWithNewModel,
    permissionPromptTool: runtime.provider.permissionPromptTool,
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
  /** Name of a disk-only skill (no DB entry) - used when id starts with "disk:" */
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

// Merge-resolution state machine

/**
 * Explicit outcomes from the merge pre-flight checks.
 *
 * `conflict-ready`  - conflicts exist; caller should invoke fix-and-merge.
 * `error-skip`      - a non-conflict error blocked the merge (dirty main, bad
 *                     branch state, stale build); caller should surface the
 *                     WorkspaceError and stop without launching fix-and-merge.
 * `proceed`         - all checks passed; caller should execute the git merge.
 * `reconcile`       - branch is already an ancestor (previously merged); caller
 *                     should mark Done without a git merge.
 * `already-merged`  - mergedAt already stamped (dropped-response retry); caller
 *                     should return merged-as-noop.
 * `already-closed`  - workspace is already closed without mergedAt; caller should
 *                     409 (`already_closed`).
 * `not-approved`    - non-direct workspace not readyForMerge; caller should
 *                     409 (`not_approved`).
 * `direct-close`    - isDirect workspace; no git op, just close.
 */
export type MergeResolutionState =
  | { kind: "already-merged" }
  | { kind: "direct-close" }
  | { kind: "already-closed"; status: string }
  | { kind: "not-approved"; status: string }
  | { kind: "reconcile"; branchSha: string; baseSha: string; uniqueCommits: number }
  | { kind: "clean-ancestor"; branchSha: string; baseSha: string; uniqueCommits: number }
  | { kind: "conflict-ready"; conflictFiles: string[]; behindCount?: number; error: WorkspaceError }
  | { kind: "error-skip"; error: WorkspaceError }
  | { kind: "proceed" };

export type ResolveMergeStateDeps = {
  gitService: GitService;
  /** When true, skip the readyForMerge gate so auto_merge_in_review can land committed In Review work. */
  autoMergeInReview?: boolean;
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
  const { gitService, autoMergeInReview } = deps;

  // mergedAt is stamped immediately after git merge lands (#575 crash-recovery guard).
  // If it's set, the merge already completed — run cleanup and move to Done without
  // another git merge, regardless of workspace.status.
  //
  // Trust-but-verify (#820): the "already-merged" path deletes the branch and moves the issue to
  // Done. Trusting the mergedAt board flag ALONE is a silent-merge-loss vector — the flag can go
  // stale (a deferred working-tree sync that reverted, a base reset, a crash between the early
  // stamp and finalize) while the branch is NOT actually on the base branch. So verify via git:
  //   - branch tip IS an ancestor of base  → genuinely merged, honor the flag.
  //   - branch ref is gone (branchSha null) → merged-and-deleted by normal cleanup, honor the flag.
  //   - branch still EXISTS but is NOT an ancestor → the flag is lying. Do NOT short-circuit (which
  //     would delete the branch + mark Done and lose the work); fall through to normal resolution so
  //     the work is actually merged (reconcile/proceed) or surfaced as a conflict.
  if (workspace.mergedAt) {
    const verify = await gitService.checkBranchTipIsAncestor(
      repoPath,
      workspace.branch,
      baseBranch,
      workspace.workingDir ?? undefined,
    );
    if (verify.isAncestor || verify.branchSha === null) {
      return { kind: "already-merged" };
    }
    console.warn(
      `[workspace-merge] stale mergedAt on ws=${workspace.id}: branch '${workspace.branch}' (${verify.branchSha}) is NOT an ancestor of '${baseBranch}' — re-resolving instead of silently marking Done (#820)`,
    );
  }

  if (workspace.status === "closed") {
    return { kind: "already-closed", status: workspace.status };
  }

  // Skip the readyForMerge gate when auto_merge_in_review is enabled — committed In Review
  // work should land without a manual ready marking.
  if (!workspace.isDirect && !workspace.readyForMerge && !autoMergeInReview) {
    return { kind: "not-approved", status: workspace.status };
  }

  if (workspace.isDirect) {
    return { kind: "direct-close" };
  }

  // Branch-level checks require a non-null workingDir; skip cleanly if absent.
  // Dirty-main guard: main checkout must not have uncommitted tracked changes.
  if (!workspace.isDirect && typeof gitService.getUncommittedTrackedChanges === "function") {
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

  const ancestryResult = await gitService.checkBranchTipIsAncestor(
    repoPath,
    workspace.branch,
    baseBranch,
    workspace.workingDir ?? undefined,
  );
  if (ancestryResult.isAncestor) {
    const { branchSha, baseSha } = ancestryResult;
    const uniqueCommits = await gitService.countUniqueCommits(repoPath, baseSha, branchSha).catch(() => 0);
    const originalUniqueCommits = uniqueCommits === 0 && branchSha !== baseSha && workspace.baseCommitSha
      ? await gitService.countUniqueCommits(repoPath, workspace.baseCommitSha, branchSha).catch(() => 0)
      : 0;
    if (uniqueCommits > 0 || originalUniqueCommits > 0) {
      return { kind: "reconcile", branchSha, baseSha, uniqueCommits };
    }
    if (uniqueCommits === 0) {
      return { kind: "clean-ancestor", branchSha, baseSha, uniqueCommits };
    }
  }
  const conflictResult = await detectWorkspaceMergeConflicts({ workspace, repoPath, baseBranch, gitService });
  if (conflictResult.kind === "conflict") {
    const data = conflictResult.behindCount
      ? { mergeReason: "conflict", conflictFiles: conflictResult.conflictFiles, behindCount: conflictResult.behindCount }
      : { mergeReason: "conflict", conflictFiles: conflictResult.conflictFiles };
    return {
      kind: "conflict-ready",
      conflictFiles: conflictResult.conflictFiles,
      behindCount: conflictResult.behindCount,
      error: new WorkspaceError(
        conflictResult.behindCount
          ? `Merge conflicts detected (branch is ${conflictResult.behindCount} commit(s) behind ${baseBranch})`
          : "Merge conflicts detected",
        "CONFLICT",
        data,
      ),
    };
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
