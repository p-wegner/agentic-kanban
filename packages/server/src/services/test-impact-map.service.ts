/**
 * Keep the committed test-impact map fresh (#952), and feed it real durations (#955).
 *
 * `docs/tests/impact-map.json` is what `impact.mjs select` reads to narrow a gate run to the
 * tests a diff can actually affect. It does not FAIL when stale — it WIDENS: past
 * `staleWidenAfterCommits` the selection silently drops from the impact tier to the package
 * tier, i.e. the whole package suite. Measured on this repo, the committed map went 146
 * commits behind in four days, so the saving disappeared exactly when the repo was busiest.
 *
 * ## Storage decision: the map stays COMMITTED, with exactly ONE writer
 *
 * The alternative (untracked, rebuilt per checkout) costs every worktree ~7.4s and gives up
 * shared freshness. Committed is only safe because of the single-writer rule, and both halves
 * below are load-bearing:
 *
 *  - **This pass, on the project's MAIN CHECKOUT, is the only thing that regenerates it.**
 *    Builders in worktrees read it and never rebuild. That is what makes this different from
 *    the `.claude/smart-hooks-rules.json` scar (see `project-scaffold/commit.ts`), where a
 *    volatile generated file was rewritten by every branch and so made every merge conflict
 *    on it. Here the condition is removed, not tolerated.
 *  - **`docs/tests/impact-map.json merge=ours` in `.gitattributes`**, so a branch that somehow
 *    carries an older map cannot conflict on it either.
 *
 * ## Why it takes the repo lock
 *
 * `landMergeTrain` refuses to land a train whose base HEAD moved since the tree was assembled
 * ("refusing to land an unverified tree"). A commit made on master WITHOUT holding the queue
 * repo lock can therefore kill an in-flight train. So the regenerate+commit runs under
 * `acquireQueueRepoLock` — with a SHORT timeout, and the pass is SKIPPED on timeout rather
 * than waited out. A map one cycle stale is harmless; a killed train is not.
 *
 * ## Why it cannot leave the tree dirty
 *
 * An uncommitted generated file in the main checkout blocks EVERY subsequent merge on
 * `dirty_main` (`getDirtyMainFiles`, `merge-executor.service.ts`). So build-then-commit is one
 * unit under the lock: if the commit step fails, the pass restores the file to HEAD.
 *
 * ## Durations (#955)
 *
 * `impact.mjs build` reads durations from the `--durations` report and stores the count as
 * `durationsMeasured`; it does NOT carry them over from the previous map. So a rebuild without
 * `--durations` silently ERASES measured durations, and `select --budget 60s` falls back to
 * "budget assumes 3s/file" — files x 3s, not seconds. The pass therefore re-feeds a persisted
 * vitest JSON report on every rebuild (`docs/tests/durations.json` by default, produced by
 * `scripts/capture-test-durations.mjs`). Durations change far more slowly than the import
 * graph, so refreshing that report is occasional; re-feeding it is every time.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { execErrorMessage, execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import { getHeadState } from "@agentic-kanban/shared/lib/git-service";

import { acquireQueueRepoLock } from "./merge-queue-repo-lock.js";
import { runImpactMapBuild, runImpactMapCheck, type ImpactMapRunner } from "./test-impact-map/impact-cli.js";

/** Repo-relative path of the committed map. Mirrors the skill's default `CFG.inventory`. */
export const IMPACT_MAP_PATH = "docs/tests/impact-map.json";

/**
 * Repo-relative path of the persisted vitest JSON report re-fed on every rebuild (#955).
 * Optional: absent simply means the map carries no measured durations, as before.
 */
export const IMPACT_DURATIONS_PATH = "docs/tests/durations.json";

/** Fixed commit subject, so the commits are trivially greppable and obviously machine-made. */
export function impactMapCommitSubject(headSha: string): string {
  return `chore: rebuild test-impact map @ ${headSha}`;
}

/**
 * Lock wait budget. Deliberately SHORT: the pass is opportunistic, and the cost of waiting is
 * borne by a merge train that may be mid-assembly. One cycle of staleness is the cheap outcome.
 */
export const IMPACT_MAP_LOCK_TIMEOUT_MS = 5_000;

// #496: built from the registry, so an unregistered prefix is a COMPILE error.
const testImpactMapPrefDef = projectPref("test_impact_map");

export function testImpactMapPrefKey(projectId: string): string {
  return testImpactMapPrefDef.key(projectId);
}

/**
 * Resolve the per-project gate. Pure.
 *
 * `test_impact_map_<projectId>`: `"off"`/`"false"`/`"0"` disables it for this project;
 * anything else (including absent) follows the board-wide default passed in.
 *
 * On by default when the board-wide setting is on, like the compounding pass and unlike the
 * opt-in `auto_*` gates: the pass only rewrites a file the board itself owns, and it is a no-op
 * on any repo that does not already track a map (see `resolveImpactMapPaths`).
 */
export function resolveTestImpactMapGate(
  prefMap: Map<string, string>,
  projectId: string,
  boardWideEnabled: boolean,
): { enabled: boolean } {
  const raw = (prefMap.get(testImpactMapPrefKey(projectId)) ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "false" || raw === "0") return { enabled: false };
  return { enabled: boardWideEnabled };
}

export interface ImpactMapPaths {
  /** Absolute path of the skill's `impact.mjs`, or null when the skill is not present. */
  tool: string | null;
  /** Absolute path of the committed map. */
  map: string;
  /** Absolute path of the durations report, or null when none is committed. */
  durations: string | null;
}

/**
 * Locate the skill's CLI and the map, in the project's main checkout.
 *
 * Resolution order mirrors what the skill documents for gates and builders: the repo-local
 * skill bundle first, then the machine-wide one. A project with neither is simply not a
 * test-impact project and the pass skips it.
 */
export function resolveImpactMapPaths(repoPath: string, homeDir?: string): ImpactMapPaths {
  const candidates = [join(repoPath, ".claude", "skills", "test-impact", "tools", "impact.mjs")];
  if (homeDir) candidates.push(join(homeDir, ".claude", "skills", "test-impact", "tools", "impact.mjs"));

  const durations = join(repoPath, ...IMPACT_DURATIONS_PATH.split("/"));
  return {
    tool: candidates.find((c) => existsSync(c)) ?? null,
    map: join(repoPath, ...IMPACT_MAP_PATH.split("/")),
    durations: existsSync(durations) ? durations : null,
  };
}

export type ImpactMapOutcome =
  | "rebuilt"
  | "fresh"
  | "no_skill"
  | "no_map"
  | "lock_busy"
  | "detached_head"
  | "build_failed"
  | "commit_failed";

export interface ImpactMapResult {
  outcome: ImpactMapOutcome;
  /** Human-readable detail for the monitor log line. */
  detail?: string;
  /** HEAD the map was rebuilt at, when `outcome === "rebuilt"`. */
  headSha?: string;
  /** Whether a durations report was fed to the build (#955). */
  durationsFed?: boolean;
}

export interface ImpactMapPassDeps {
  homeDir?: string;
  /** Injected for tests; defaults to spawning the real `impact.mjs`. */
  runner?: ImpactMapRunner;
  /** Injected for tests; defaults to the real queue repo lock. */
  acquireLock?: typeof acquireQueueRepoLock;
  lockTimeoutMs?: number;
}

/**
 * Run the pass for one main checkout. Never throws: every failure is an outcome the caller logs.
 *
 * The freshness CHECK runs outside the lock (it is a cheap `git rev-list` and reads no index),
 * so a steady-state board never contends for the lock at all. Only an actually-stale map
 * acquires it.
 */
export async function runTestImpactMapPass(
  repoPath: string,
  deps: ImpactMapPassDeps = {},
): Promise<ImpactMapResult> {
  // `homedir()` rather than reading HOME/USERPROFILE: it is the cross-platform API for exactly
  // this, and it keeps the module off the env-read-ownership register (#707) for a variable
  // that is not really ours to own.
  const { homeDir = homedir(), runner, acquireLock = acquireQueueRepoLock } = deps;
  const paths = resolveImpactMapPaths(repoPath, homeDir);

  if (!paths.tool) return { outcome: "no_skill" };
  // Only a project that ALREADY tracks a map is one this pass maintains. Creating one on a
  // repo that never asked for it would commit a 1.4 MB file into someone else's tree.
  if (!existsSync(paths.map)) return { outcome: "no_map" };

  // Before the freshness check, not inside the rebuild branch: the attribute is inert until the
  // driver exists, so a checkout whose map never goes stale would otherwise never get it
  // registered — and that is precisely a checkout whose merges would then conflict on the map.
  await ensureOursMergeDriver(repoPath);

  // Outside the lock and outside the build's try/finally, so it gets its own guard: this
  // function's contract is that it never throws, and a spawn failure here (ENOENT, a node that
  // will not start) must be an outcome the monitor logs, not an exception in the cycle.
  let check: { fresh: boolean; detail: string };
  try {
    check = await runImpactMapCheck(paths.tool, repoPath, runner);
  } catch (err) {
    return { outcome: "build_failed", detail: err instanceof Error ? err.message : String(err) };
  }
  if (check.fresh) return { outcome: "fresh" };

  let lock: Awaited<ReturnType<typeof acquireQueueRepoLock>>;
  try {
    lock = await acquireLock(repoPath, "test-impact-map", {
      timeoutMs: deps.lockTimeoutMs ?? IMPACT_MAP_LOCK_TIMEOUT_MS,
    });
  } catch (err) {
    // Contention OR an unlockable path: either way, skipping is correct. Waiting risks the
    // in-flight train's base moving under it, which is the failure this lock exists to avoid.
    return { outcome: "lock_busy", detail: err instanceof Error ? err.message : String(err) };
  }

  try {
    // A detached HEAD has no branch to commit onto — same guard `commitProjectScaffoldArtifacts`
    // makes. An unborn branch has no HEAD to name in the subject and no committed map to restore
    // to on failure, and `resolveImpactMapPaths` has already established a map exists, so it
    // cannot be a tracked file yet. Either way, rebuilding would leave the tree dirty and dirty
    // main blocks every subsequent merge.
    const head = await getHeadState(repoPath);
    if (head.kind !== "branch") return { outcome: "detached_head", detail: `HEAD is ${head.kind}` };

    const build = await runImpactMapBuild(paths.tool, repoPath, paths.durations, runner);
    if (!build.ok) {
      // The build writes the map in one `writeFileSync`, but a partial/failed run must not leave
      // a modified file behind — dirty main blocks every merge.
      await restoreMapFile(repoPath);
      return { outcome: "build_failed", detail: build.detail };
    }

    const commit = await commitImpactMap(repoPath);
    if (commit.outcome === "commit_failed") await restoreMapFile(repoPath);
    return { ...commit, durationsFed: paths.durations !== null };
  } catch (err) {
    await restoreMapFile(repoPath);
    return { outcome: "build_failed", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    lock.release();
  }
}

/**
 * Commit ONLY the map, by pathspec.
 *
 * Pathspec-limited, never `git add` + `git commit`: several agents commit in this checkout and
 * the index is shared process-wide, so staging would sweep whatever they have staged into this
 * chore commit under this subject (see the root CLAUDE.md — it has happened).
 *
 * The durations report is deliberately NOT in the pathspec: this pass only READS it, and it is
 * refreshed by hand (`pnpm test:durations`) and committed by whoever ran it.
 */
async function commitImpactMap(repoPath: string): Promise<ImpactMapResult> {
  const headSha = (await gitExec(["rev-parse", "--short", "HEAD"], { cwd: repoPath })).stdout.trim();

  // Nothing changed (the map was stale by commit count but byte-identical) — no empty commit.
  const dirty = await gitExec(["status", "--porcelain", "--", IMPACT_MAP_PATH], { cwd: repoPath });
  if (!dirty.stdout.trim()) return { outcome: "fresh", detail: "rebuild produced no change" };

  const commit = await gitExec(
    ["commit", "-m", impactMapCommitSubject(headSha), "--", IMPACT_MAP_PATH],
    { cwd: repoPath },
  );
  if (!execSucceeded(commit)) {
    return { outcome: "commit_failed", detail: execErrorMessage(commit).slice(0, 400) };
  }
  return { outcome: "rebuilt", headSha };
}

/** Put the map back the way HEAD has it, so a failed pass never leaves main dirty. */
async function restoreMapFile(repoPath: string): Promise<void> {
  await gitExec(["checkout", "--", IMPACT_MAP_PATH], { cwd: repoPath });
}

/**
 * Register the `ours` merge driver in the repo's local config, so the `.gitattributes` line
 * `docs/tests/impact-map.json merge=ours` actually does something.
 *
 * This is NOT redundant with the attribute, and the ordering trap is worth stating: git has no
 * built-in `ours` driver (only `text`/`binary`/`union`). `merge=ours` naming an unregistered
 * driver is silently IGNORED — measured: the merge still conflicts, byte for byte as if the
 * attribute were absent. And `.git/config` is not checked in, so the attribute alone would be
 * inert in every clone and every worktree. The board therefore registers it on the main
 * checkout, where it already holds the repo and the lock.
 *
 * `driver = true` is the standard spelling: git invokes the command and, on success, takes the
 * already-in-place %A (our version) as the result. `--local`, so we never touch a user's global
 * git config. Idempotent — re-setting the same value each pass is a no-op write.
 */
async function ensureOursMergeDriver(repoPath: string): Promise<void> {
  const existing = await gitExec(["config", "--local", "--get", "merge.ours.driver"], { cwd: repoPath });
  if (existing.stdout.trim()) return;
  await gitExec(["config", "--local", "merge.ours.name", "keep our version of a generated file"], { cwd: repoPath });
  await gitExec(["config", "--local", "merge.ours.driver", "true"], { cwd: repoPath });
}
