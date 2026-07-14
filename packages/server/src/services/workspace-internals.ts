import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { workspaces } from "@agentic-kanban/shared/schema";
import type { WorkspaceSetupRun, WorkspaceSymlinkRun } from "@agentic-kanban/shared";
import { tryAcquireRepoLock, type RepoLockHandle } from "@agentic-kanban/shared/lib/repo-lock";
import type { Database } from "../db/index.js";
import { listWorkspaceRepos, type RepoRow } from "../repositories/repo.repository.js";
import type { ProviderName } from "./agent-provider.js";
import type { AgentSettings } from "./agent-settings.service.js";
import { loadProjectRuntimeConfig } from "./project-runtime-config.service.js";
import * as realGitService from "./git.service.js";
import { detectWorkspaceMergeConflicts } from "./workspace-merge-conflict.service.js";
import { getDirtyMainFiles } from "./merge-executor.service.js";

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
  /**
   * Multi-repo awareness: when provided, the ancestor short-circuits (`reconcile` /
   * `clean-ancestor`) additionally verify that NO sibling repo still has unmerged
   * commits. Sibling-only work (the core multi-repo use case) must `proceed` to the
   * full merge pipeline instead of being skipped — or worse, marked Done — on the
   * leading repo's evidence alone. Optional so single-repo callers/tests are unchanged.
   */
  database?: Database;
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
  // (Delegates to the shared merge-executor primitive so the git call exists once — #945.)
  if (!workspace.isDirect) {
    try {
      const uncommitted = await getDirtyMainFiles(repoPath, gitService);
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
    // Multi-repo: the leading repo being clean/landed does NOT mean the workspace is
    // done — a sibling repo may hold the workspace's actual work (a sibling-only
    // ticket's leading branch is a fresh 0-commit cut, which used to short-circuit to
    // clean-ancestor forever, or to reconcile→Done with the sibling work unlanded).
    // When any sibling still has unmerged commits, proceed with the full merge: the
    // leading merge is a no-op ("Already up to date") and the sibling pipeline
    // (prevalidateSiblingMerges → executeSiblingMerges) lands the real work.
    const pendingSiblings = deps.database
      ? await listPendingSiblingMerges(gitService, deps.database, workspace.id)
      : [];
    if (pendingSiblings.length > 0) {
      console.log(
        `[workspace-merge] leading branch '${workspace.branch}' is clean on ${baseBranch} but ` +
          `${pendingSiblings.length} sibling repo(s) still have unmerged commits — proceeding with the multi-repo merge instead of short-circuiting`,
      );
      return { kind: "proceed" };
    }
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

// ─── Multi-repo pending-sibling helpers ──────────────────────────────────────

/**
 * A sibling repo with unmerged work. Structurally compatible with
 * `SiblingMergePlan` (workspace-repos.service.ts) so callers can hand the pending
 * set straight to `executeSiblingMerges`.
 */
export interface PendingSiblingMerge {
  repo: RepoRow;
  uniqueCommits: number;
}

/**
 * List the workspace's sibling repos that still have UNMERGED work: workspace-scoped
 * `repos` rows WITHOUT a stamped mergedHeadSha whose branch still exists and is ahead
 * of its base branch. Rows already landed (mergedHeadSha set), already cleaned (branch
 * ref gone) or with nothing to land (0 commits ahead) are not pending.
 *
 * This is the shared "is the workspace REALLY fully merged?" probe used by the merge
 * pre-flight, the already-merged reconciliations, and the stranded-sibling startup
 * reconciler. Deliberately DISTINCT from `prevalidateSiblingMerges`, which fails hard
 * on any unresolvable row — after a partial merge + cleanup, rows whose branch was
 * legitimately deleted are expected and must not read as failures.
 *
 * Best-effort reads: a git error on one repo skips it (reads as "not pending").
 * That is the safe direction — every deletion path re-verifies with its own
 * preserveUnmerged probe before destroying anything.
 */
export async function listPendingSiblingMerges(
  gitService: GitService,
  database: Database,
  workspaceId: string,
): Promise<PendingSiblingMerge[]> {
  let rows: RepoRow[];
  try {
    rows = await listWorkspaceRepos(workspaceId, database);
  } catch (err) {
    console.warn(
      `[workspace-merge] pending-sibling scan: failed to list repos for ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  const pending: PendingSiblingMerge[] = [];
  for (const repo of rows) {
    if (repo.mergedHeadSha) continue; // landed and stamped
    if (!repo.branch || !repo.baseBranch) continue;
    try {
      // countUniqueCommits NEVER throws (returns 0 on any git error), which would read
      // an unreachable repo as "nothing pending" — resolve both refs first (revParse
      // throws). A branch ref that is GONE genuinely has nothing left to land.
      await gitService.revParse(repo.path, repo.baseBranch);
      await gitService.revParse(repo.path, repo.branch);
    } catch {
      continue;
    }
    const ahead = await gitService.countUniqueCommits(repo.path, repo.baseBranch, repo.branch).catch(() => 0);
    if (ahead > 0) pending.push({ repo, uniqueCommits: ahead });
  }
  return pending;
}

/**
 * The same per-repo guards `prevalidateSiblingMerges` runs (dirty main checkout,
 * HEAD-on-baseBranch, read-only conflict check), applied to an already-detected
 * PENDING set. Returns human-readable failures; empty means the pending merges are
 * safe to land via `executeSiblingMerges`. Conflict detection uses the branch-name
 * variant so it works even when the sibling worktree was already removed.
 */
export async function checkPendingSiblingMergeGuards(
  gitService: GitService,
  pending: PendingSiblingMerge[],
): Promise<string[]> {
  const failures: string[] = [];
  for (const { repo } of pending) {
    const label = repo.name ?? repo.path;
    const dirty = await gitService.getUncommittedTrackedChanges(repo.path).catch(() => [] as string[]);
    if (dirty.length > 0) {
      failures.push(`${label}: main checkout has ${dirty.length} uncommitted tracked change(s)`);
      continue;
    }
    const head = await gitService.getCurrentBranch(repo.path).catch(() => "");
    if (head !== repo.baseBranch) {
      failures.push(`${label}: main checkout HEAD is on '${head}' but the workspace targets '${repo.baseBranch}'`);
      continue;
    }
    if (typeof gitService.detectConflictsByBranch === "function") {
      const conflicts = await gitService.detectConflictsByBranch(repo.path, repo.branch!, repo.baseBranch!).catch(() => null);
      if (conflicts?.hasConflicts) {
        failures.push(
          `${label}: merge conflicts in ${conflicts.conflictingFiles.slice(0, 5).join(", ")}${conflicts.conflictingFiles.length > 5 ? ", …" : ""}`,
        );
      }
    }
  }
  return failures;
}

export const MERGE_LOCK_STALE_MS = 15 * 60 * 1000;

export interface ActiveMergeLock {
  /**
   * Lock-lifetime promise: settles only when the merge AND every registered
   * hold extension (e.g. the deferred post-merge main-checkout cleanup, #970)
   * have completed. Waiters in {@link acquireRepoMergeLock} await THIS.
   */
  promise: Promise<unknown>;
  /**
   * The merge's own result promise (the value the HTTP caller receives).
   * Settles as soon as the merge response is ready — possibly BEFORE the lock
   * is released. Used by the manual-merge reuse path; falls back to `promise`
   * for entries created without it (tests, legacy).
   */
  resultPromise?: Promise<unknown>;
  workspaceId: string;
  repoPath: string;
  startedAt: string;
  startedAtMs: number;
}

/** Merge serialization: one active merge per repo at a time. Shared across services. */
export const activeMerges = new Map<string, ActiveMergeLock>();

/**
 * A `.git/index.lock` younger than this in the target repo means a git process
 * is very likely still running there — refuse stale-lock recovery (#970).
 */
export const GIT_INDEX_LOCK_FRESH_MS = 2 * 60 * 1000;

/**
 * Recover a stale merge lock — but only if it looks safe (#970).
 *
 * The old behavior deleted the map entry after 15 minutes without checking
 * whether the holder's git process was actually gone. Before force-releasing,
 * we now look for a live `.git/index.lock` in the target repo: a FRESH one
 * (mtime < {@link GIT_INDEX_LOCK_FRESH_MS}) means git is probably still
 * running, so we refuse recovery and the caller keeps waiting/refusing. An OLD
 * index.lock is most likely debris from a crashed git — we recover, but log
 * loudly so the operator sees it.
 *
 * Returns true if the map entry was removed (caller may proceed).
 */
export function tryRecoverStaleMergeLock(repoPath: string, lock: ActiveMergeLock, nowMs = Date.now()): boolean {
  const indexLockPath = join(repoPath, ".git", "index.lock");
  try {
    if (existsSync(indexLockPath)) {
      const ageMs = nowMs - statSync(indexLockPath).mtimeMs;
      if (ageMs < GIT_INDEX_LOCK_FRESH_MS) {
        console.error(
          `[merge-lock] REFUSING stale merge-lock recovery: ${indexLockPath} is only ${Math.round(ageMs / 1000)}s old — ` +
            `the holder's git process (workspace ${lock.workspaceId}) may still be running in ${repoPath}.`,
        );
        return false;
      }
      console.error(
        `[merge-lock] recovering stale merge lock DESPITE ${indexLockPath} (age ${Math.round(ageMs / 1000)}s): ` +
          `the holder (workspace ${lock.workspaceId}) likely crashed mid-git. If merges keep failing, remove the index.lock manually.`,
      );
    }
  } catch (err) {
    console.warn(
      `[merge-lock] index.lock check failed (proceeding with recovery): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  console.warn(
    `[merge-lock] recovering stale merge lock: repoPath=${repoPath} activeWorkspaceId=${lock.workspaceId}`,
  );
  if (activeMerges.get(repoPath) === lock) {
    activeMerges.delete(repoPath);
  }
  return true;
}

/**
 * Poll for the on-disk repo lock (#993) — the cross-process source of truth
 * that guards the shared main checkout against every writer, not just this
 * server process: a Conductor-loop agent's own `git` commands, a human
 * running git by hand, or a second server instance surviving a hot-reload
 * restart all contend for the SAME lockfile. The in-memory `activeMerges` map
 * stays as the in-process waiter queue (so same-process callers get
 * promise-based waiting instead of polling), but admission is only granted
 * once the on-disk lock is actually held.
 */
async function acquireOnDiskRepoLock(repoPath: string, workspaceId: string): Promise<RepoLockHandle> {
  for (;;) {
    const handle = tryAcquireRepoLock(repoPath, `workspace:${workspaceId}`);
    if (handle) return handle;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Acquire the per-repo merge lock and run `work` under it (#944, on-disk
 * cross-process lock added in #993).
 *
 * This is the ONE correct acquisition protocol for `activeMerges`:
 * - Waiters loop: after any wait they RE-CHECK the map before proceeding, so two
 *   concurrent callers waiting on the same in-flight merge serialize strictly
 *   one-after-the-other instead of both proceeding (the old wait-then-proceed race).
 * - The lock entry is installed synchronously after the (also synchronous) final
 *   map check, so a second caller can never overwrite the first's entry.
 * - Stale locks (holder lost to a hot-reload) are recovered exactly like the
 *   manual-merge path does.
 * - Once admitted in-process, the caller still acquires the on-disk lockfile
 *   (`@agentic-kanban/shared/lib/repo-lock`) before `work` runs — this is what
 *   makes the lock visible to writers outside this process. A heartbeat keeps
 *   the on-disk lock fresh for the duration of `work` (+ any hold extensions),
 *   and it is always released in a `finally`.
 *
 * Callers that want refuse/reuse semantics instead of queueing (manual merge)
 * should check the map themselves first and only call this when they intend to
 * proceed.
 *
 * `work` receives an `extendHold` callback (#970): promises registered through
 * it — synchronously or at any point before the LAST registered extension
 * settles — keep the lock held after `work`'s own result resolves. This lets
 * the merge return its HTTP response early while the deferred post-merge
 * cleanup (which `git reset --hard`s the MAIN checkout's working tree) still
 * runs INSIDE the lock, so a second merge can never observe the stale tree and
 * trip its dirty-main guard mid-cleanup.
 */
export async function acquireRepoMergeLock<T>(
  repoPath: string,
  workspaceId: string,
  work: (extendHold: (p: Promise<unknown>) => void) => Promise<T>,
  onWait?: (holder: ActiveMergeLock) => void,
): Promise<T> {
  for (;;) {
    const existing = activeMerges.get(repoPath);
    if (!existing) break;
    if (describeMergeLock(existing).isStale && tryRecoverStaleMergeLock(repoPath, existing)) {
      break;
    }
    onWait?.(existing);
    await existing.promise.catch(() => {});
    // Loop and re-check: another waiter may have installed a fresh lock while
    // we were awaiting — never proceed just because the awaited promise settled.
  }

  const diskLock = await acquireOnDiskRepoLock(repoPath, workspaceId);
  const heartbeatTimer = setInterval(() => diskLock.heartbeat(), 15_000);

  const holdExtensions: Promise<unknown>[] = [];
  const extendHold = (p: Promise<unknown>) => {
    holdExtensions.push(p.catch(() => {}));
  };

  // No awaits between the check above and the set below (work()'s synchronous
  // prefix runs inline, but nothing else can interleave on the event loop), so
  // installation is atomic with respect to other acquirers.
  const resultPromise = work(extendHold);
  const lock: ActiveMergeLock = {
    promise: Promise.resolve(), // replaced with the real hold promise just below
    resultPromise,
    workspaceId,
    repoPath,
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
  };
  // Lock lifetime = result + every registered hold extension. Never rejects.
  // The map delete runs INSIDE this chain (not via a separate .then on it) so
  // that with no extensions the entry is gone in the same microtask the result
  // settles in — i.e. before the caller's own `await` resumes, preserving the
  // pre-#970 observable release ordering. Success or rejection both release,
  // so a crashed merge never strands the repo behind a stale in-memory lock.
  lock.promise = (async () => {
    try {
      await resultPromise;
    } catch {
      /* rejection still releases the lock (after extensions, if any) */
    }
    while (holdExtensions.length > 0) {
      await holdExtensions.shift();
    }
    if (activeMerges.get(repoPath) === lock) {
      activeMerges.delete(repoPath);
    }
    clearInterval(heartbeatTimer);
    diskLock.release();
  })();
  activeMerges.set(repoPath, lock);
  return resultPromise;
}

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
