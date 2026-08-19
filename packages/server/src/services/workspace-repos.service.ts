/**
 * Multi-repo workspace support (full-peers model): provisioning and cleanup of the
 * SIBLING worktrees created for a project's additional repos. The leading repo's
 * worktree stays on the workspaces row and is handled by the legacy paths; both
 * functions here are strict no-ops for single-repo projects (no `repos` rows),
 * which is the zero-regression mechanism.
 */

import { existsSync } from "node:fs";
import { basename } from "node:path";
import { runSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import type { Database, TransactionClient } from "../db/index.js";
import { listProjectRepos, listWorkspaceRepos, insertWorkspaceRepo, setWorkspaceRepoMergedSha, setWorkspaceRepoInstallState, findLiveSiblingSharers, findCrossProjectBranchHolders, type RepoRow } from "../repositories/repo.repository.js";
import { getAllWorkspaceRepos, siblingRefFromRow, stampRepoMergedHeadSha, type WorkspaceRepoRef } from "./workspace-all-repos.js";
import { WorkspaceError, acquireRepoMergeLock, type GitService } from "./workspace-internals.js";
import { runMergeCore } from "./merge-executor.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { getPreference } from "../repositories/preferences.repository.js";

/**
 * Resolve the subset of a project's ADDITIONAL repos that a workspace should span,
 * honoring an optional per-repo `repoScope` chosen at creation time (#91).
 *
 * `repoScope` is the set of repo identifiers (id, name, absolute path, or the repo
 * directory's basename — any of which the UI/API may send) that the workspace spans,
 * INCLUDING the leading repo. The leading repo is provisioned unconditionally by the
 * caller and never appears in `projectRepos`, so filtering here only ever narrows the
 * siblings.
 *
 * Zero-regression default: an OMITTED (`undefined`) or EMPTY scope means "all repos"
 * — the exact pre-#91 behavior. A deselect-all-siblings choice from the UI still
 * carries the always-included leading repo, so it arrives as a NON-empty scope that
 * simply matches no sibling → empty result (leading-only), distinct from the
 * omitted/empty "all" default.
 */
export function resolveScopedSiblingRepos(
  projectRepos: RepoRow[],
  repoScope: string[] | undefined,
): RepoRow[] {
  if (!repoScope || repoScope.length === 0) return projectRepos;
  const scope = new Set(repoScope.map((s) => s.trim().toLowerCase()).filter(Boolean));
  return projectRepos.filter((repo) => {
    const identifiers = [repo.id, repo.name ?? "", repo.path, basename(repo.path)]
      .filter(Boolean)
      .map((s) => s.toLowerCase());
    return identifiers.some((id) => scope.has(id));
  });
}

/**
 * The effective repo scope for a workspace, given what the caller asked for and what the
 * TICKET declares (#629).
 *
 * A ticket already says which repos it touches: `POST /api/issues` accepts `reposTouched` and
 * stores it as `repo:<name>` tags (#94). Workspace creation never read it back, so
 * `resolveScopedSiblingRepos` saw an omitted scope and did the zero-regression thing — all
 * repos. Measured on `comet`: `POST /api/workspaces/preview` for a ticket whose work is
 * entirely in the leading `documentation` repo returned all 17 repos `selected: true`, each
 * getting a worktree and a full dependency install.
 *
 * Precedence, and why:
 *  1. An EXPLICIT `repoScope` always wins. A human (or an API client) who named the repos has
 *     more context than the ticket's tags, including the right to widen them.
 *  2. Otherwise the ticket's `reposTouched`, plus the leading repo — which is always
 *     provisioned anyway, and which `resolveScopedSiblingRepos` expects to be present in a
 *     non-empty scope (an empty scope means "all", so the leading entry is what distinguishes
 *     "leading only" from "everything").
 *  3. Otherwise the LEADING repo only.
 *
 * Step 3 was "all repos" until #633 landed. The argument for keeping it was that an untagged
 * ticket which genuinely spans repos would get one worktree and an agent that cannot see the
 * code it was sent to change — a confusing failure, versus a merely slow one. That traded a
 * rare confusing failure for a universal expensive one: on `comet` every untagged ticket
 * provisioned 17 worktrees and 16 sequential dependency installs (209 s each, warm) before the
 * agent read a single file. Now that "Repos touched" is editable on an existing issue (#633),
 * the tag is the ticket's own statement of scope, and an absent tag is best read as
 * "leading repo" rather than "everything". Widening is one field on the ticket or one
 * `repoScope` in the request; unwinding 17 worktrees is not.
 */
export function resolveEffectiveRepoScope(args: {
  explicit?: string[];
  reposTouched: readonly string[];
  leadingRepoName: string;
}): string[] | undefined {
  if (args.explicit && args.explicit.length > 0) return args.explicit;
  const touched = args.reposTouched.map((r) => r.trim()).filter(Boolean);
  if (touched.length === 0) return args.leadingRepoName ? [args.leadingRepoName] : undefined;
  // The leading repo is provisioned unconditionally; including it keeps the scope's meaning
  // explicit ("these repos") rather than accidentally reading as a sibling filter.
  const scope = [args.leadingRepoName, ...touched];
  const seen = new Set<string>();
  return scope.filter((r) => {
    const key = r.toLowerCase();
    if (!r || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A sibling worktree provisioned for one additional repo of the project. */
export interface SiblingWorktree {
  path: string;
  name: string | null;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseCommitSha: string | null;
  /** Per-repo compose file (relative to the repo), if this repo ships its own stack (#71). */
  composeFile: string | null;
  /**
   * #628 — this repo's dependency install was DEFERRED (install mode `background`) and still
   * has to run. Absent/false on every inline-install path, where the install already ran.
   */
  installDeferred?: boolean;
}

/** Bounded-concurrency `map`. Preserves input order; every task is awaited before returning. */
async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * How many sibling worktrees to create at once (#626).
 *
 * `git worktree add` in repo A constrains nothing in repo B — they are independent
 * checkouts — so the old sequential loop was wall-clock spent for no reason. Bounded rather
 * than unbounded because a 17-repo project would otherwise storm one disk with 17 concurrent
 * checkouts, which is slower than a queue, not faster.
 */
const SIBLING_WORKTREE_CONCURRENCY = 6;

/** Bound for the PARALLEL install mode (#627). Lower than the worktree bound: an install is
 *  CPU+network heavy and contends on a shared package cache, which a checkout does not. */
const SIBLING_INSTALL_CONCURRENCY = 4;

/**
 * #627 `sequential` | `parallel` run the installs INLINE, before the workspace row exists.
 * #628 adds `background`: provisioning returns as soon as the worktrees are on disk and the
 * installs run after the agent has already launched. That is the difference between an agent
 * reading its first file in seconds and waiting 30-60 minutes on a 17-repo project — at the
 * cost that the agent may briefly see a worktree without its dependencies, which is why the
 * merge gate refuses to land a workspace whose installs are still outstanding or failed.
 */
export type SiblingInstallMode = "sequential" | "parallel" | "background";

const siblingInstallModePref = projectPref("sibling_install_mode");
const siblingInstallTimeoutPref = projectPref("sibling_install_timeout_ms");

/** Bounds a per-repo install timeout override to something sane: 30s .. 3h. */
const MIN_INSTALL_TIMEOUT_MS = 30_000;
const MAX_INSTALL_TIMEOUT_MS = 3 * 60 * 60 * 1000;

/**
 * Read the two sibling-install knobs for a project (#627). Never throws and never guesses:
 * an absent, unreadable or unrecognised value falls back to today's behaviour
 * (`sequential`, and the setup script's own default timeout), because a provisioning
 * default that changes on a malformed preference is worse than one that ignores it.
 */
export async function resolveSiblingInstallOptions(
  projectId: string,
  database: Database,
): Promise<{ installMode: SiblingInstallMode; installTimeoutMs: number | undefined }> {
  const rawMode = (await getPreference(siblingInstallModePref.key(projectId), database).catch(() => null))
    ?.trim()
    .toLowerCase();
  const rawTimeout = await getPreference(siblingInstallTimeoutPref.key(projectId), database).catch(() => null);
  const parsed = rawTimeout ? Number.parseInt(rawTimeout, 10) : NaN;
  return {
    installMode: rawMode === "parallel" || rawMode === "background" ? rawMode : "sequential",
    installTimeoutMs:
      Number.isFinite(parsed) && parsed >= MIN_INSTALL_TIMEOUT_MS && parsed <= MAX_INSTALL_TIMEOUT_MS
        ? parsed
        : undefined,
  };
}

/**
 * Run one repo's setup script in its worktree. Best-effort + non-fatal, mirroring the
 * leading-repo setup script's semantics — a failed sibling setup must not abort creation.
 */
async function runSiblingSetup(repo: RepoRow, worktreePath: string, timeoutMs: number | undefined): Promise<void> {
  if (!repo.setupScript || !repo.setupScript.trim()) return;
  try {
    const res = await runSetupScript(worktreePath, repo.setupScript, timeoutMs ? { timeoutMs } : {});
    if (res.exitCode !== 0) {
      console.warn(`[workspace-repos] setup script for ${repo.name ?? repo.path} exited ${res.exitCode}: ${res.stderr.slice(0, 300)}`);
    }
  } catch (err) {
    console.warn(`[workspace-repos] setup script for ${repo.name ?? repo.path} failed (non-fatal): ${errorMessage(err)}`);
  }
}

/** Does this repo have a setup script worth running at all? */
export function repoNeedsInstall(repo: Pick<RepoRow, "setupScript">): boolean {
  return Boolean(repo.setupScript && repo.setupScript.trim());
}

/**
 * #628 — run the deferred sibling installs AFTER the agent has launched, recording per-repo
 * state on the workspace's repo rows as it goes so the UI can render "installing 3/16" and
 * the merge gate can refuse a branch whose deps never came up.
 *
 * Never throws: it is called fire-and-forget from the deferred launch path, where a rejection
 * would surface as a launch failure for a workspace whose agent is already running fine.
 */
export async function runBackgroundSiblingInstalls(params: {
  workspaceId: string;
  projectId: string;
  siblings: SiblingWorktree[];
  database: Database;
  installMode: SiblingInstallMode;
  installTimeoutMs?: number;
  onProgress?: () => void;
}): Promise<void> {
  const { workspaceId, projectId, database } = params;
  const pending = params.siblings.filter((s) => s.installDeferred);
  if (pending.length === 0) return;

  const allRepos = await listProjectRepos(projectId, database).catch(() => [] as RepoRow[]);
  const byPath = new Map(allRepos.map((r) => [r.path, r]));
  // `background` describes WHEN, not HOW: the installs themselves still contend on one
  // package cache, so they run one at a time exactly like the `sequential` default.
  const concurrency = 1;

  console.log(`[workspace-repos] background installs starting for workspace ${workspaceId} (${pending.length} repo(s))`);
  await mapBounded(pending, concurrency, async (sibling) => {
    const repo = byPath.get(sibling.path);
    if (!repo || !repoNeedsInstall(repo)) {
      await setWorkspaceRepoInstallState({ workspaceId, path: sibling.path, state: "skipped", detail: "no setup script" }, database).catch(() => {});
      params.onProgress?.();
      return;
    }
    await setWorkspaceRepoInstallState({ workspaceId, path: sibling.path, state: "running" }, database).catch(() => {});
    params.onProgress?.();
    const outcome = await runSiblingSetupReporting(repo, sibling.worktreePath, params.installTimeoutMs);
    await setWorkspaceRepoInstallState(
      { workspaceId, path: sibling.path, state: outcome.ok ? "done" : "failed", detail: outcome.detail },
      database,
    ).catch(() => {});
    params.onProgress?.();
  });
  console.log(`[workspace-repos] background installs finished for workspace ${workspaceId}`);
}

/** `runSiblingSetup` with the verdict returned instead of only logged (#628). */
async function runSiblingSetupReporting(
  repo: RepoRow,
  worktreePath: string,
  timeoutMs: number | undefined,
): Promise<{ ok: boolean; detail: string | null }> {
  try {
    const res = await runSetupScript(worktreePath, repo.setupScript!, timeoutMs ? { timeoutMs } : {});
    if (res.exitCode !== 0) {
      const detail = `exit ${res.exitCode}: ${res.stderr.slice(0, 300)}`;
      console.warn(`[workspace-repos] setup script for ${repo.name ?? repo.path} ${detail}`);
      return { ok: false, detail };
    }
    return { ok: true, detail: null };
  } catch (err) {
    const detail = errorMessage(err);
    console.warn(`[workspace-repos] setup script for ${repo.name ?? repo.path} failed: ${detail}`);
    return { ok: false, detail };
  }
}

/**
 * Create a worktree on `branch` in every additional repo of the project (same branch
 * name as the leading repo). Worktrees land at `dirname(repoPath)/.worktrees/...`,
 * which repos sharing a parent directory SHARE — the guaranteed layout for
 * clone-from-URL repos — so every worktree is namespaced by its repo's directory
 * name (`.worktrees/<repoDirName>/<branch>`). That is now `createWorktree`'s DEFAULT
 * for the leading repo too (#385 — the un-namespaced single-repo scheme made a path
 * ambiguous about which project owned it), so no explicit `pathNamespace` is passed
 * here any more.
 *
 * Two phases since #626/#627, because they have different constraints:
 *
 *  1. **Worktree creation — always concurrent** (bounded). The repos are independent
 *     checkouts; the old sequential loop bought nothing. The cross-project shared-sibling
 *     guard (#110) still runs immediately before each `createWorktree`, per repo.
 *  2. **Dependency installs — sequential by DEFAULT**, `parallel` opt-in per project.
 *     Parallel Maven/npm against one shared local cache contends, so the default stays
 *     today's behaviour and the trade-off is the operator's.
 *
 * Still all-or-nothing: full-peers semantics require every repo present, so ANY worktree
 * failure rolls back every worktree this call created — including the ones that succeeded
 * concurrently alongside the failure, which is why phase 1 collects settled results instead
 * of throwing at the first rejection. The caller never sees a partial list (the throw
 * prevents the assignment), so an internal rollback is the only way they get removed.
 */
export async function provisionSiblingWorktrees(params: {
  gitService: GitService;
  database: Database;
  projectId: string;
  branch: string;
  /**
   * Optional per-repo scope (#91): the identifiers of the repos this workspace
   * spans (leading + selected siblings). Only siblings in scope get a worktree.
   * Omitted/empty = all siblings (zero-regression default). See
   * {@link resolveScopedSiblingRepos}.
   */
  repoScope?: string[];
  /** #627 — `sequential` (default) or `parallel` per-repo dependency installs. */
  installMode?: SiblingInstallMode;
  /** #627 — per-repo setup timeout. Unset inherits DEFAULT_SETUP_SCRIPT_TIMEOUT_MS (5 min),
   *  which a Maven repo measured at 209 s WARM can exceed from cold. */
  installTimeoutMs?: number;
  /**
   * #629 — the create request's `skipSetup`. It suppressed the LEADING repo's setup script but
   * was never forwarded here, so on a multi-repo project there was no way to skip the installs
   * that actually dominate provisioning (16 sequential Maven installs, 209 s each warm).
   */
  skipSetup?: boolean;
}): Promise<SiblingWorktree[]> {
  const { gitService, database, projectId, branch } = params;
  const allProjectRepos = await listProjectRepos(projectId, database);
  if (allProjectRepos.length === 0) return [];
  const projectRepos = resolveScopedSiblingRepos(allProjectRepos, params.repoScope);
  if (projectRepos.length === 0) return [];

  // Phase 1 — worktrees, concurrently. Each task returns EITHER a provisioned sibling or the
  // error it hit; nothing throws out of the map, because a rejection racing other in-flight
  // creations would leave those worktrees on disk with no one holding a reference to remove
  // them — the orphan-debris failure #630 describes, arriving via the rollback path.
  type Outcome = { ok: true; sibling: SiblingWorktree; repo: RepoRow } | { ok: false; err: unknown };
  const outcomes = await mapBounded(projectRepos, SIBLING_WORKTREE_CONCURRENCY, async (repo): Promise<Outcome> => {
    try {
      const baseBranch = repo.defaultBranch;
      if (!baseBranch) {
        throw new Error(
          `Additional repo ${repo.name ?? repo.path} has no default branch — re-add it or set one.`,
        );
      }
      // Cross-project shared-sibling guard (#110): the same repo can be a sibling of
      // two projects. Git allows only one worktree per branch, so if a live workspace
      // in ANOTHER project already holds this branch in this repo, createWorktree would
      // silently ADOPT it — conflating two projects' work onto one branch. Refuse with a
      // clear error instead. Same-project reuse is intentional and excluded by projectId.
      const crossHolders = await findCrossProjectBranchHolders(
        { repoPath: repo.path, branch, projectId },
        database,
      );
      if (crossHolders.length > 0) {
        const h = crossHolders[0];
        throw new WorkspaceError(
          `Shared repo '${repo.name ?? basename(repo.path)}' cannot be provisioned on branch '${branch}': that branch is already checked out in this repo by a live workspace (${h.workspaceId}) in a different project (${h.projectId}). Git allows only one worktree per branch, so the two projects would silently share one worktree and conflate their work. Use a distinct branch name, or drive this shared repo from a single project.`,
          "CONFLICT",
        );
      }
      const baseCommitSha = await gitService.revParse(repo.path, baseBranch);
      // No pathNamespace: createWorktree already namespaces by basename(repo.path).
      const worktreePath = await gitService.createWorktree(repo.path, branch, baseBranch);
      return {
        ok: true,
        repo,
        sibling: { path: repo.path, name: repo.name, worktreePath, branch, baseBranch, baseCommitSha, composeFile: repo.composeFile ?? null },
      };
    } catch (err) {
      return { ok: false, err };
    }
  });

  const succeeded = outcomes.filter((o): o is Extract<Outcome, { ok: true }> => o.ok);
  const firstFailure = outcomes.find((o): o is Extract<Outcome, { ok: false }> => !o.ok);
  if (firstFailure) {
    // Roll back EVERYTHING this call created, including worktrees that finished successfully
    // in parallel with the failure — full-peers semantics mean a partial set is not a result.
    await rollbackSiblingWorktrees(gitService, succeeded.map((o) => o.sibling));
    throw firstFailure.err;
  }

  // Phase 2 — per-repo setup/install (#71): each additional repo may need its own deps ready
  // in its worktree before the agent runs (`pnpm install`, `cargo fetch`, `uv sync`, …).
  // Sequential by default (#627): parallel Maven/npm against one shared local cache contends,
  // so opting into `parallel` is the operator's call per project.
  const withSetup = params.skipSetup
    ? []
    : succeeded.filter((o) => o.repo.setupScript && o.repo.setupScript.trim());
  if (params.skipSetup) {
    console.log("[workspace-repos] skipSetup — sibling dependency installs skipped by request");
  }
  // #628 — `background` defers phase 2 entirely. The caller runs it via
  // `runBackgroundSiblingInstalls` once the workspace row exists to record state on, so the
  // agent launches against bare worktrees instead of waiting out the installs.
  if (params.installMode === "background" && withSetup.length > 0) {
    console.log(
      `[workspace-repos] deferring ${withSetup.length} sibling setup script(s) to the background (install mode: background)`,
    );
    return succeeded.map((o) => ({ ...o.sibling, installDeferred: repoNeedsInstall(o.repo) }));
  }
  if (withSetup.length > 0) {
    const parallel = params.installMode === "parallel";
    const concurrency = parallel ? SIBLING_INSTALL_CONCURRENCY : 1;
    console.log(
      `[workspace-repos] running ${withSetup.length} sibling setup script(s) ${parallel ? `in parallel (max ${concurrency})` : "sequentially"}`,
    );
    await mapBounded(withSetup, concurrency, (o) => runSiblingSetup(o.repo, o.sibling.worktreePath, params.installTimeoutMs));
  }

  return succeeded.map((o) => o.sibling);
}

/** Persist the per-workspace worktree records inside the caller's transaction. */
export async function insertSiblingWorktreeRecords(
  workspaceId: string,
  projectId: string,
  siblings: SiblingWorktree[],
  database: Database | TransactionClient,
): Promise<void> {
  for (const s of siblings) {
    await insertWorkspaceRepo({
      workspaceId,
      projectId,
      // #628: a deferred install is `pending` from the moment the row exists, so the merge
      // gate refuses this branch even if the server dies before the runner starts.
      installState: s.installDeferred ? "pending" : null,
      path: s.path,
      name: s.name,
      worktreePath: s.worktreePath,
      branch: s.branch,
      baseBranch: s.baseBranch,
      baseCommitSha: s.baseCommitSha,
      composeFile: s.composeFile,
    }, database);
  }
}

/**
 * Compensating rollback for sibling worktrees provisioned before a create failure
 * (mirror of rollbackOrphanedWorktree for the leading repo). Best-effort per repo.
 */
export async function rollbackSiblingWorktrees(
  gitService: GitService,
  siblings: SiblingWorktree[],
): Promise<void> {
  for (const s of siblings) {
    try {
      await gitService.removeWorktree(s.path, s.worktreePath);
    } catch (err) {
      console.warn(`[workspaces] failed to remove sibling worktree ${s.worktreePath}: ${errorMessage(err)}`);
    }
  }
}

/** A sibling repo that prevalidated clean and has commits to land. */
export interface SiblingMergePlan {
  repo: RepoRow;
  uniqueCommits: number;
}

/**
 * All-or-nothing prevalidation for the sibling repos of a multi-repo merge, run
 * BEFORE the leading repo's merge executes. Repos 0 commits ahead are skipped.
 * For each repo with commits: dirty-main guard, HEAD-on-baseBranch guard, and a
 * read-only merge-tree conflict check. ANY failure throws (nothing merged yet),
 * with a per-repo report — so a conflicted sibling can never leave the leading
 * repo merged and the sibling behind. Returns the repos to actually merge.
 * No-op ([]) for single-repo workspaces.
 */
export async function prevalidateSiblingMerges(params: {
  gitService: GitService;
  database: Database;
  workspaceId: string;
}): Promise<SiblingMergePlan[]> {
  const { gitService, database, workspaceId } = params;
  const rows = await listWorkspaceRepos(workspaceId, database);
  if (rows.length === 0) return [];

  const plans: SiblingMergePlan[] = [];
  const failures: string[] = [];
  for (const repo of rows) {
    const label = repo.name ?? repo.path;
    if (!repo.branch || !repo.baseBranch) continue;
    let uniqueCommits = 0;
    try {
      // countUniqueCommits(repoPath, baseSha, branchSha) = commits in base..branch.
      // It NEVER throws — it returns 0 on any git error — which would silently drop
      // an unverifiable repo from the merge plan. Resolve both refs first (revParse
      // throws) so a missing repo/ref FAILS prevalidation instead.
      await gitService.revParse(repo.path, repo.baseBranch);
      await gitService.revParse(repo.path, repo.branch);
      uniqueCommits = await gitService.countUniqueCommits(repo.path, repo.baseBranch, repo.branch);
    } catch (err) {
      failures.push(`${label}: could not count commits (${errorMessage(err)})`);
      continue;
    }
    if (uniqueCommits === 0) continue;

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
    if (repo.worktreePath) {
      const conflicts = await gitService.detectConflicts(repo.worktreePath, repo.baseBranch).catch(() => null);
      if (conflicts?.hasConflicts) {
        failures.push(`${label}: merge conflicts in ${conflicts.conflictingFiles.slice(0, 5).join(", ")}${conflicts.conflictingFiles.length > 5 ? ", …" : ""}`);
        continue;
      }
    }
    plans.push({ repo, uniqueCommits });
  }

  if (failures.length > 0) {
    throw new WorkspaceError(
      `Multi-repo merge blocked — nothing was merged. Sibling repo prevalidation failed:\n- ${failures.join("\n- ")}`,
      "CONFLICT",
      { mergeReason: "sibling_prevalidation_failed", failures },
    );
  }
  return plans;
}

export interface SiblingMergeResult {
  repoId: string;
  name: string | null;
  path: string;
  merged: boolean;
  mergedHeadSha?: string;
  error?: string;
}

/**
 * Land the prevalidated sibling merges sequentially, AFTER the leading repo's merge.
 * Each repo is merged under its own repo merge lock (acquired one at a time — never
 * two sibling locks held together, so lock ordering can't deadlock) and its
 * merged_head_sha is stamped on the workspace-scoped repos row. A failure here is a
 * post-prevalidation race; it is reported per-repo, never thrown — the leading merge
 * has already landed and the caller records the partial state on the issue.
 */
export async function executeSiblingMerges(params: {
  gitService: GitService;
  database: Database;
  createBackup: (reason: string) => Promise<unknown>;
  workspaceId: string;
  plans: SiblingMergePlan[];
}): Promise<SiblingMergeResult[]> {
  const { gitService, database, createBackup, workspaceId, plans } = params;
  const results: SiblingMergeResult[] = [];
  for (const { repo } of plans) {
    const label = repo.name ?? repo.path;
    try {
      const core = await acquireRepoMergeLock(repo.path, workspaceId, () =>
        runMergeCore({
          repoPath: repo.path,
          branch: repo.branch!,
          targetBranch: repo.baseBranch!,
          gitService,
          createBackup,
          deferWorkingTreeSync: false,
          makeAncestryError: (branch, target) =>
            new Error(`Post-merge invariant violated in ${label}: '${branch}' is still not an ancestor of '${target}'`),
        }),
      );
      await setWorkspaceRepoMergedSha(repo.id, core.mergedHeadSha, database);
      results.push({ repoId: repo.id, name: repo.name, path: repo.path, merged: true, mergedHeadSha: core.mergedHeadSha });
      console.log(`[workspace-merge] sibling merge landed: ${label} ${repo.branch} → ${repo.baseBranch} (${core.mergedHeadSha})`);
    } catch (err) {
      const message = errorMessage(err);
      results.push({ repoId: repo.id, name: repo.name, path: repo.path, merged: false, error: message });
      console.error(`[workspace-merge] sibling merge FAILED for ${label}: ${message}`);
    }
  }
  return results;
}

/**
 * Stamp `mergedHeadSha` on each sibling repo that has ALREADY landed its work but was
 * never recorded — the fix-and-merge / reconcile-as-done path (#114).
 *
 * `executeSiblingMerges` is the only place that stamps `mergedHeadSha`, and it only runs
 * when the board itself performs the sibling git merge. The reconcile-as-done path
 * (`reconcileAlreadyMerged`) instead accepts sibling work the RECONCILER AGENT already
 * merged into each sibling main by hand, so nothing ever stamps those rows. Without the
 * stamp, `getRepoMergeStatus` (#75) reads every cleaned-up sibling as unmerged after the
 * reconcile close — a false negative on a fully-landed multi-repo merge (observed as
 * "1/10 merged" though all mains are correct).
 *
 * This closes that gap by recording positive evidence from git ground truth: for each
 * unstamped sibling whose branch tip still resolves and which introduced real commits
 * relative to its cut point (`baseCommitSha`), stamp the branch tip as `mergedHeadSha`.
 * MUST be called BEFORE `cleanupSiblingWorktrees` force-deletes the sibling branches, so
 * the landed tip is captured while the ref still exists (it then survives cleanup).
 *
 * Safety / idempotency:
 * - Skips rows already stamped (`mergedHeadSha` set) — never overwrites executeSiblingMerges.
 * - Skips rows whose branch ref is gone (can't capture a landed tip) and rows with no
 *   historic commits (an empty sibling has no merged work; `mergedHeadSha` means "had
 *   work AND landed"), so it can never falsely mark an empty sibling merged.
 * - Callers gate on the workspace being genuinely already-merged (`checkAlreadyMerged`
 *   verified no sibling has PENDING unmerged commits), so a branch that is 0-ahead of
 *   base but >0 vs its cut point has demonstrably landed.
 *
 * Returns the number of rows stamped. No-op ([] → 0) for single-repo workspaces.
 */
export async function stampReconciledSiblingMerges(params: {
  gitService: GitService;
  database: Database;
  workspaceId: string;
}): Promise<number> {
  const { gitService, database, workspaceId } = params;
  let rows: RepoRow[];
  try {
    rows = await listWorkspaceRepos(workspaceId, database);
  } catch (err) {
    console.warn(`[workspace-merge] reconcile stamp: failed to list repos for ${workspaceId}: ${errorMessage(err)}`);
    return 0;
  }
  const now = new Date().toISOString();
  let stamped = 0;
  for (const row of rows) {
    if (await stampReconciledRepoMerge(siblingRefFromRow(row), gitService, database, now)) stamped++;
  }
  return stamped;
}

/**
 * Stamp `mergedHeadSha` on the LEADING workspace row when its branch has ALREADY landed but
 * was never recorded — the fix-and-merge / reconcile-as-done close path (#115). Thin wrapper
 * over the shared {@link stampReconciledRepoMerge} core (the leading/sibling algorithm is now
 * ONE function, #168); kept as a named export because callers/tests reference it directly.
 * Returns true when the leading row was stamped, false otherwise.
 */
export async function stampReconciledLeadingMerge(params: {
  gitService: GitService;
  database: Database;
  workspaceId: string;
  now?: string;
}): Promise<boolean> {
  const { gitService, database, workspaceId } = params;
  const now = params.now ?? new Date().toISOString();
  let repos: WorkspaceRepoRef[];
  try {
    repos = await getAllWorkspaceRepos(workspaceId, database);
  } catch (err) {
    console.warn(`[workspace-merge] reconcile leading stamp: failed to load workspace ${workspaceId}: ${errorMessage(err)}`);
    return false;
  }
  const leading = repos.find((r) => r.kind === "leading");
  if (!leading) return false;
  return stampReconciledRepoMerge(leading, gitService, database, now);
}

/**
 * Stamp EVERY repo the workspace spans (leading + siblings) in one pass over the uniform repo
 * view (#168) — the single call that replaces the historical `stampReconciledSiblingMerges`
 * + `stampReconciledLeadingMerge` back-to-back pair at reconcile close sites. Idempotent:
 * already-stamped repos are skipped, so calling it after `executeSiblingMerges` re-stamps nothing.
 */
export async function stampReconciledMerges(params: {
  gitService: GitService;
  database: Database;
  workspaceId: string;
  now?: string;
}): Promise<{ leading: boolean; siblings: number }> {
  const { gitService, database, workspaceId } = params;
  const now = params.now ?? new Date().toISOString();
  let repos: WorkspaceRepoRef[];
  try {
    repos = await getAllWorkspaceRepos(workspaceId, database);
  } catch (err) {
    console.warn(`[workspace-merge] reconcile stamp: failed to list repos for ${workspaceId}: ${errorMessage(err)}`);
    return { leading: false, siblings: 0 };
  }
  let leading = false;
  let siblings = 0;
  for (const ref of repos) {
    const ok = await stampReconciledRepoMerge(ref, gitService, database, now);
    if (ref.kind === "leading") leading = ok;
    else if (ok) siblings++;
  }
  return { leading, siblings };
}

/**
 * The single per-repo reconcile-stamp algorithm shared by leading and sibling (#168 — collapses
 * the two near-identical 50-line mirrors `stampReconciledSiblingMerges` /
 * `stampReconciledLeadingMerge`). Records positive git ground-truth evidence for a repo whose
 * branch has ALREADY landed but was never stamped (agent-performed merge / reconcile-as-done),
 * capturing the branch tip while the ref still exists so it survives the upcoming cleanup.
 * MUST run BEFORE branch cleanup force-deletes the refs.
 *
 * Safety / idempotency (identical for both kinds):
 * - Skips if `mergedHeadSha` is already set — never overwrites executeSiblingMerges / clean auto-merge.
 * - Skips if the branch ref is gone or there is no cut point (`baseCommitSha ?? baseBranch`).
 * - Only stamps when the branch introduced real commits vs its ORIGINAL cut point; a sibling-only
 *   ticket's empty leading branch (0 historic commits) stays unstamped, preserving #75/#114.
 * The write routes to the correct storage via {@link stampRepoMergedHeadSha} (workspace row vs repos row).
 */
async function stampReconciledRepoMerge(
  ref: WorkspaceRepoRef,
  gitService: GitService,
  database: Database,
  now: string,
): Promise<boolean> {
  if (ref.mergedHeadSha) return false; // already recorded
  if (!ref.branch) return false;
  // Post-landing the branch is an ancestor of base (0 commits AHEAD), so measure against the
  // ORIGINAL cut point instead. Prefer the recorded cut commit; fall back to the base branch.
  const base = ref.baseCommitSha ?? ref.baseBranch;
  if (!base) return false; // no cut point → cannot verify landed work
  // The commit the (agent-performed) merge landed. Captured from the branch ref while it still
  // exists — this is what survives the upcoming branch cleanup and is read as the historic tip.
  let branchTip: string;
  try {
    branchTip = (await gitService.revParse(ref.path, ref.branch)).trim();
  } catch {
    return false; // branch ref gone → nothing to capture
  }
  if (!branchTip) return false;
  // countUniqueCommits never throws (0 on git error); resolve the base ref first so an
  // unresolvable cut point does not read as "no work".
  let historic = 0;
  try {
    await gitService.revParse(ref.path, base);
    historic = await gitService.countUniqueCommits(ref.path, base, branchTip);
  } catch {
    historic = 0;
  }
  if (historic === 0) return false; // contributed nothing — leave unstamped
  await stampRepoMergedHeadSha(ref, branchTip, now, database);
  console.log(`[workspace-merge] reconcile stamp: ${ref.kind} ${ref.name ?? ref.path} mergedHeadSha=${branchTip} (${historic} commit(s) landed)`);
  return true;
}

/**
 * Remove the workspace's sibling worktrees AND their branches. Branch deletion is
 * mandatory (force): a stale branch left in a sibling repo would be silently reused
 * by the next workspace on the same branch name, basing it on an old commit.
 * Best-effort per repo; never throws. The `repos` rows themselves are removed by
 * cascade-delete when the workspace row goes away, so they are left untouched here
 * (they double as the merge audit trail via mergedHeadSha).
 *
 * Shared-worktree guard: createWorktree's reuse path hands a second workspace on
 * the same branch the SAME sibling worktree, so multiple workspaces' repos rows can
 * reference one worktree/branch. A repo whose worktree or branch is still referenced
 * by another live (non-closed) workspace is skipped entirely — the sibling analog of
 * deleteWorkspace's findWorkspacesByWorkingDir guard for the leading worktree.
 */
export async function cleanupSiblingWorktrees(
  gitService: GitService,
  workspaceId: string,
  database: Database,
  opts: {
    /**
     * Preserve-work mode: a row WITHOUT mergedHeadSha is either "had no commits"
     * (safe to clean) or "carries unmerged commits" (work would be destroyed).
     * Probe via base..branch ancestry to tell them apart — an unmerged sibling
     * keeps its worktree AND branch for fix-up/recovery. Post-merge cleanup and
     * the branch-preserving paths (closeWorkspace, stale-worktree cleanup) set
     * this so sibling semantics mirror the leading repo's, which those paths never
     * force-delete either. deleteWorkspace leaves it off: the workspace is being
     * destroyed outright, force-delete everything (stale-branch reuse guard).
     *
     * Also gates a DIRTY-WORKTREE guard (#153), independent of mergedHeadSha: a
     * sibling worktree with uncommitted (tracked or untracked) changes is preserved
     * even if its commits already landed, since `git worktree remove --force` would
     * silently destroy that uncommitted work.
     */
    preserveUnmerged?: boolean;
  } = {},
): Promise<void> {
  let rows: RepoRow[];
  try {
    rows = await listWorkspaceRepos(workspaceId, database);
  } catch (err) {
    console.warn(`[workspaces] sibling cleanup: failed to list repos for ${workspaceId}: ${errorMessage(err)}`);
    return;
  }
  for (const repo of rows) {
    // Shared-worktree guard: skip repos whose worktree/branch another live
    // workspace still references — removing them would blank that workspace's
    // diffs, break its merge prevalidation, and force-delete its commits.
    // On a failed check, skip too (leak beats destroying shared work).
    try {
      const sharers = await findLiveSiblingSharers(repo, workspaceId, database);
      if (sharers.length > 0) {
        console.log(`[workspaces] sibling worktree ${repo.worktreePath ?? repo.branch} in ${repo.path} still referenced by ${sharers.length} other workspace(s) — skipping removal`);
        continue;
      }
    } catch (err) {
      console.warn(`[workspaces] sibling cleanup: sharer check failed for ${repo.path}: ${errorMessage(err)} — skipping removal to be safe`);
      continue;
    }
    // Dirty-worktree guard (#153): a sibling worktree may carry UNCOMMITTED edits —
    // tracked or untracked — that the pending-commit probe below never sees (it only
    // reads landed commits). `git worktree remove --force` would silently destroy
    // that work, so this check runs regardless of mergedHeadSha, ahead of the
    // commit-based preserve logic. Skipped when the worktree directory is already
    // gone (nothing left to lose); a git failure to read status is fail-closed
    // (kept) since we cannot prove the worktree is safe to force-remove.
    if (opts.preserveUnmerged === true && repo.worktreePath && existsSync(repo.worktreePath)) {
      try {
        const diff = await gitService.getWorkingTreeDiff(repo.worktreePath);
        if (diff.trim() !== "") {
          console.warn(`[workspaces] sibling cleanup: preserving ${repo.worktreePath} in ${repo.path} — uncommitted changes would be destroyed by worktree remove --force`);
          continue;
        }
      } catch (err) {
        console.warn(`[workspaces] sibling cleanup: preserving ${repo.worktreePath} in ${repo.path} — could not verify working-tree status: ${errorMessage(err)}`);
        continue;
      }
    }

    const mustPreserveCheck = opts.preserveUnmerged === true && !repo.mergedHeadSha;
    if (mustPreserveCheck && repo.branch && repo.worktreePath) {
      // Safe-delete probe requires the worktree gone first (the branch is checked
      // out there), so probe via merge-tree-free ancestry instead: 0 commits ahead
      // of base means nothing unmerged. countUniqueCommits NEVER throws (it returns
      // 0 on any git error) — which would read as "fully merged" and force-delete
      // unverified work — so resolve the refs with revParse (throws) first. A
      // branch ref that is GONE means there is nothing to preserve: fall through
      // to the normal worktree/branch cleanup.
      let branchExists = true;
      try {
        await gitService.revParse(repo.path, repo.branch);
      } catch {
        branchExists = false;
      }
      if (branchExists) {
        try {
          const base = repo.baseBranch ?? "HEAD";
          await gitService.revParse(repo.path, base);
          const ahead = await gitService.countUniqueCommits(repo.path, base, repo.branch);
          if (ahead > 0) {
            console.warn(`[workspaces] sibling cleanup: preserving ${repo.branch} in ${repo.path} — ${ahead} unmerged commit(s) (sibling merge did not land)`);
            continue;
          }
        } catch {
          console.warn(`[workspaces] sibling cleanup: preserving ${repo.branch} in ${repo.path} — could not verify merge state`);
          continue;
        }
      }
    }
    if (repo.worktreePath) {
      try {
        await gitService.removeWorktree(repo.path, repo.worktreePath);
      } catch (err) {
        console.warn(`[workspaces] sibling cleanup: failed to remove worktree ${repo.worktreePath}: ${errorMessage(err)}`);
      }
    }
    if (repo.branch) {
      try {
        await gitService.deleteBranch(repo.path, repo.branch, { force: true });
      } catch (err) {
        console.warn(`[workspaces] sibling cleanup: failed to delete branch ${repo.branch} in ${repo.path}: ${errorMessage(err)}`);
      }
    }
  }
}
