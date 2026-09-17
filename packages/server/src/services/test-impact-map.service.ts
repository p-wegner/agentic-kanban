/**
 * Keep the test-impact map fresh (#952), feed it real durations (#955), and — since #1018 — keep
 * it OUT of git.
 *
 * `docs/tests/impact-map.json` is what `impact.mjs select` reads to narrow a gate run to the
 * tests a diff can actually affect. It does not FAIL when stale — it WIDENS: past
 * `staleWidenAfterCommits` the selection silently drops from the impact tier to the package
 * tier, i.e. the whole package suite. Measured on this repo, the committed map went 146
 * commits behind in four days, so the saving disappeared exactly when the repo was busiest.
 *
 * ## Storage decision (#1018): the map is an UNTRACKED, gitignored artifact
 *
 * It used to be committed, and this pass committed it — `chore: rebuild test-impact map @ <sha>`,
 * every cycle in which it had gone stale. That was 11 of 261 commits in the measured window
 * (`docs/proposals/2026-09-03-dev-board-vs-deployed-board.md` §3.B), and **every one of them moved
 * the base under a running pre-merge gate**. #243 discards a gate verdict whose base tip moved, so
 * a 590-second PASSED run was thrown away by this pass's own chore commit. #998 papered over the
 * worst case by deferring while a merge was in flight; the commits still landed, and they still
 * counted as base movement for the next gate.
 *
 * So the map now lives at the same path, untracked: `.gitignore` carries it, and the pass rebuilds
 * it IN PLACE. Nothing is committed, so there is no base movement, no `merge=ours` residue, and no
 * merge deferral to reason about.
 *
 * **Why the alternative lost.** The other candidate was to keep the map committed but commit it
 * exactly once a day, immediately before promotion (`scripts/promote.mjs`, #1014), and never from
 * this 15-minute pass. It is the smaller change, and it does cut the commit count from ~11/day to
 * 1/day — but it keeps the defect's mechanism and trades away the thing the map is for:
 *   - a once-a-day map is up to a day stale BY CONSTRUCTION. This repo lands well over 30 commits
 *     a day, which is the skill's `staleWidenAfterCommits` threshold, so the selection would spend
 *     most of every day silently widened to the package tier — the exact #993 failure, made
 *     permanent by design rather than by accident;
 *   - it still moves the base under whatever gate is running at promotion time. The failure gets
 *     rarer, not gone, and a rare base-movement bug is harder to attribute than a frequent one;
 *   - it keeps a 1.4 MB one-line-per-entry generated file in every branch diff, every rebase and
 *     every `git log -p`, for a file no human reads.
 * Untracked costs two things in exchange, and both are cheap and visible: a fresh clone has no map
 * until the first sweep runs (~7.4s), and worktrees need one materialized (below).
 *
 * ## The single-writer property, restated for an untracked file
 *
 * Only THIS pass, on a project's MAIN CHECKOUT, ever writes the map. Builders in worktrees read a
 * copy materialized for them at provisioning/relaunch
 * (`services/test-impact-map/worktree-map.ts`) and never rebuild — `KANBAN_IMPACT_REBUILD` is off
 * by default precisely so a worktree cannot write one (see `scripts/test-mine.mjs`).
 *
 * ## What makes it refresh (#1046) — and the bound that follows
 *
 * Three triggers, all of them writing through THIS pass on the main checkout:
 *
 *  - the monitor phase (`startup/monitor-test-impact-map.ts`), every cycle, before the auto-start
 *    fan-out;
 *  - the 15-minute background sweep (`startup/test-impact-map-reconciler.ts`, #993), which is what
 *    covers a `manual` project the cycle never visits;
 *  - **a landed merge** (`services/test-impact-map/post-merge.ts`), which is the one #1046 added.
 *
 * The first two ask the TOOL whether the map is stale, and the tool's threshold is generous
 * (`staleWidenAfterCommits` = 30). That is why a map measured 23-24 commits behind was still
 * "fresh" and nothing rebuilt it: the trigger existed, the answer was just always no, and the day
 * it flipped the gate silently widened to the package tier. The merge trigger therefore applies its
 * OWN, tighter bound and forces a rebuild past it — see `IMPACT_MAP_MAX_COMMITS_BEHIND`. The
 * resulting guarantee is statable: **after a merge completes, the map is at most
 * `IMPACT_MAP_MAX_COMMITS_BEHIND` commits behind that project's HEAD**, rather than at most
 * whatever the tool tolerates.
 *
 * ## What "fresh" means now that the file is not committed
 *
 * Exactly what it always meant; the definition never depended on tracking. `impact.mjs check`
 * compares the map's own recorded `commit:` stamp against HEAD (`git rev-list --count
 * <stamp>..HEAD`) and against the test files changed since. Fresh = that stamp is reachable, within
 * `staleWidenAfterCommits` commits of HEAD, and adds no new test file. So the gate's `map fresh` /
 * `map STALE` clause (`pre-merge-gate-tier.ts`) keeps meaning the same thing after this change, and
 * it now describes the WORKTREE's materialized copy — which is the map the run actually used.
 *
 * ## Opt-in is `git check-ignore`, not "a map is already there"
 *
 * The old guard was "only maintain a map this repo already tracks", which stopped the pass
 * committing a 1.4 MB file into someone else's tree. Untracked, the equivalent hazard is a DIRTY
 * main checkout — an untracked generated file blocks every subsequent merge on `dirty_main`
 * (`getDirtyMainFiles`, `merge-executor.service.ts`). So a project opts in by IGNORING the path,
 * which is a fact the pass can VERIFY rather than assume: the map is written only when git reports
 * the path as ignored and not tracked. A repo that has not gitignored it is left alone.
 *
 * ## Why it still takes the repo lock
 *
 * Not for a commit any more — there is none. Two callers share this pass (the monitor phase and
 * the #993 background sweep), and the build ends in a single large `writeFileSync`; the lock is
 * what keeps two overlapping rebuilds from interleaving into a half-written map that every
 * subsequent `select` would then fail to parse. SHORT timeout, and SKIPPED on timeout rather than
 * waited out: a map one cycle stale is harmless.
 *
 * ## Durations (#955)
 *
 * `impact.mjs build` reads durations from the `--durations` report and stores the count as
 * `durationsMeasured`; it does NOT carry them over from the previous map. So a rebuild without
 * `--durations` silently ERASES measured durations, and `select --budget 60s` falls back to
 * "budget assumes 3s/file" — files x 3s, not seconds. The pass therefore re-feeds a persisted
 * vitest JSON report on every rebuild (`docs/tests/durations.json` by default, produced by
 * `scripts/capture-test-durations.mjs`). That report IS still committed, and correctly so: it is
 * written by hand, changes rarely, and nothing on the merge path rewrites it.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";

import { acquireQueueRepoLock } from "./merge-queue-repo-lock.js";
import { runImpactMapBuild, runImpactMapCheck, type ImpactMapRunner } from "./test-impact-map/impact-cli.js";

/** Repo-relative path of the map. Mirrors the skill's default `CFG.inventory`. */
export const IMPACT_MAP_PATH = "docs/tests/impact-map.json";

/**
 * Repo-relative path of the persisted vitest JSON report re-fed on every rebuild (#955).
 * Optional: absent simply means the map carries no measured durations, as before.
 */
export const IMPACT_DURATIONS_PATH = "docs/tests/durations.json";

/**
 * Lock wait budget. Deliberately SHORT: the pass is opportunistic, and the only thing the lock
 * buys is that two overlapping rebuilds do not interleave. One cycle of staleness is cheap.
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
 * on any repo that has not gitignored the path (see {@link resolveMapWritability}).
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
  /** Absolute path of the map. */
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
  | "map_tracked"
  | "map_not_ignored"
  | "lock_busy"
  | "build_failed";

export interface ImpactMapResult {
  outcome: ImpactMapOutcome;
  /** Human-readable detail for the monitor log line. */
  detail?: string;
  /** HEAD the map was rebuilt at, when `outcome === "rebuilt"`. */
  headSha?: string;
  /** Whether a durations report was fed to the build (#955). */
  durationsFed?: boolean;
}

export type MapWritability = "ok" | "tracked" | "not_ignored";

/**
 * May this pass write the map into this checkout? (#1018)
 *
 * Two questions, both ANSWERED BY GIT rather than guessed, because getting either wrong leaves the
 * main checkout dirty and `dirty_main` blocks every subsequent merge:
 *
 *  - **tracked?** `git ls-files -- <path>` naming the file means this checkout still has the map
 *    committed (a branch that predates #1018, or a project that never took the change). Rewriting
 *    it there shows up as a modification and stalls the merge queue. Refuse, and say what the
 *    one-time remedy is.
 *  - **ignored?** `git check-ignore -q` is the opt-in marker, and it is a marker the pass can
 *    check rather than trust. A repo that has not ignored the path would carry the rebuilt map as
 *    an untracked file — the same `dirty_main` outcome. Refuse.
 *
 * Fails CLOSED on an unreadable answer: `check-ignore` exits 1 for "not ignored" and 128 for a
 * genuine error, and both are treated as "do not write". A missed rebuild costs a wider test
 * selection; a wrongly-written file costs every merge on that project.
 */
export async function resolveMapWritability(repoPath: string): Promise<MapWritability> {
  const tracked = await gitExec(["ls-files", "--", IMPACT_MAP_PATH], { cwd: repoPath });
  if (tracked.stdout.trim()) return "tracked";
  const ignored = await gitExec(["check-ignore", "-q", "--", IMPACT_MAP_PATH], { cwd: repoPath });
  return execSucceeded(ignored) ? "ok" : "not_ignored";
}

export interface ImpactMapPassDeps {
  homeDir?: string;
  /** Injected for tests; defaults to spawning the real `impact.mjs`. */
  runner?: ImpactMapRunner;
  /** Injected for tests; defaults to the real queue repo lock. */
  acquireLock?: typeof acquireQueueRepoLock;
  lockTimeoutMs?: number;
  /**
   * Skip `impact.mjs check` and rebuild regardless of what the TOOL thinks (#1046).
   *
   * The tool's own freshness rule is deliberately generous — `staleWidenAfterCommits` is 30 — so a
   * map 24 commits behind is "fresh" to it and the periodic sweep does nothing. That is correct for
   * a sweep whose only job is to stop the map rotting, and wrong for a caller that has just moved
   * HEAD and wants the map to track it (the post-merge trigger, `test-impact-map/post-merge.ts`).
   * Such a caller applies its OWN bound and, when the map is past it, says so here rather than
   * asking a question whose answer it already knows.
   *
   * Everything else about the pass is unchanged — writability is still checked first, the lock is
   * still taken and still skipped on contention — so forcing can only ever cost one rebuild.
   */
  forceRebuild?: boolean;
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

  // Before anything expensive. Unlike the old `existsSync(map)` guard this does NOT require a map
  // to already be on disk — a fresh clone has none, and refusing there would mean a clone never
  // gets one (the #993 rot, reached through a new door). What it requires is that writing one here
  // is SAFE.
  const writability = await resolveMapWritability(repoPath);
  if (writability === "tracked") {
    return {
      outcome: "map_tracked",
      detail: `${IMPACT_MAP_PATH} is still tracked in this checkout — \`git rm --cached\` it once (#1018)`,
    };
  }
  if (writability === "not_ignored") {
    return {
      outcome: "map_not_ignored",
      detail: `${IMPACT_MAP_PATH} is not gitignored here — rebuilding it would leave main dirty (#1018)`,
    };
  }

  // Outside the lock and outside the build's try/finally, so it gets its own guard: this
  // function's contract is that it never throws, and a spawn failure here (ENOENT, a node that
  // will not start) must be an outcome the monitor logs, not an exception in the cycle.
  //
  // `check` exits 2 for "no map at all", which the adapter reports as STALE — that is what makes a
  // fresh clone build its FIRST map instead of sitting mapless forever.
  if (!deps.forceRebuild) {
    let check: { fresh: boolean; detail: string };
    try {
      check = await runImpactMapCheck(paths.tool, repoPath, runner);
    } catch (err) {
      return { outcome: "build_failed", detail: err instanceof Error ? err.message : String(err) };
    }
    if (check.fresh) return { outcome: "fresh" };
  }

  let lock: Awaited<ReturnType<typeof acquireQueueRepoLock>>;
  try {
    lock = await acquireLock(repoPath, "test-impact-map", {
      timeoutMs: deps.lockTimeoutMs ?? IMPACT_MAP_LOCK_TIMEOUT_MS,
    });
  } catch (err) {
    // Contention OR an unlockable path: either way, skipping is correct. The lock is what stops
    // two overlapping rebuilds interleaving into a half-written map.
    return { outcome: "lock_busy", detail: err instanceof Error ? err.message : String(err) };
  }

  // #1182: the build can run up to IMPACT_CLI_TIMEOUT_MS (180s), well past REPO_LOCK_STALE_MS
  // (60s) — and `acquireQueueRepoLock` hands back a bare handle whose heartbeat nobody was
  // calling. A merge train waiting on this same repo lock then saw a heartbeat stuck at 90-100s
  // while the holder pid was very much alive and simply hadn't refreshed the file, and
  // `probeHolderProcess` correctly refuses to steal a live lock — so the train waited out its
  // own 15-minute bound instead of failing fast or proceeding. `merge-queue.service.ts` already
  // pairs every long hold of this lock with a 15s heartbeat interval in a try/finally; this is
  // the same pattern, applied here for the first time.
  const repoLockHeartbeat = setInterval(() => lock.heartbeat(), 15_000);
  try {
    // Named for the log line and for the gate's `map fresh` clause: the sha the map was built AT.
    // A detached HEAD is fine now — there is no branch to commit onto, because nothing is
    // committed — so the old `detached_head` refusal went with the commit that motivated it.
    const headSha = (await gitExec(["rev-parse", "--short", "HEAD"], { cwd: repoPath })).stdout.trim();

    const build = await runImpactMapBuild(paths.tool, repoPath, paths.durations, runner);
    if (!build.ok) return { outcome: "build_failed", detail: build.detail };

    return { outcome: "rebuilt", headSha, durationsFed: paths.durations !== null };
  } catch (err) {
    return { outcome: "build_failed", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearInterval(repoLockHeartbeat);
    lock.release();
  }
}
