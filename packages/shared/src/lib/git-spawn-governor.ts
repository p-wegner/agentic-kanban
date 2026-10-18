/**
 * Background-spawn budget + caller attribution for the git adapter (#1488).
 *
 * On Windows `child_process.spawn` runs CreateProcess ON the event loop (~80-180 ms per git). A
 * profile of the live board showed 93-94% of the main thread inside spawn, fed by background sweeps
 * over hundreds of old workspaces: the slot semaphore in `git-exec.ts` bounds CONCURRENCY, but not
 * the RATE, and the loop pays per spawn, not per concurrent child. Two pieces live here, both pure
 * state with no `node:` import so `git-exec.ts` stays the only spawn site:
 *
 *  - a per-second budget for NORMAL-lane (background) spawns. `interactive` request-path spawns are
 *    never throttled and jump the queue, so a sweep yields to a user waiting on a response. The
 *    default is unlimited — the board's server entry opts in via `configureGitBackgroundSpawnBudget`,
 *    so a test run or a CLI that spawns git in bulk is not slowed.
 *  - attribution: which call site queued the spawns. The loop-lag monitor drains it when lag is
 *    high, so "the loop is saturated" arrives with "by whom".
 */

const WINDOW_MS = 1000;
/** Callers tracked per window; beyond this, new call sites fold into `OTHER_CALLER`. */
const MAX_TRACKED_CALLERS = 200;
const OTHER_CALLER = "(other)";

let backgroundPerSecond = Infinity;
/** Start times (ms) of normal-lane spawns inside the trailing window, oldest first. */
let recentStarts: number[] = [];
let callerCounts = new Map<string, number>();

/** Cap normal-lane spawn STARTS per second; `Infinity` (the default) disables the budget. */
export function configureGitBackgroundSpawnBudget(perSecond: number): void {
  backgroundPerSecond = perSecond > 0 ? perSecond : Infinity;
}

export function getGitBackgroundSpawnBudget(): number {
  return backgroundPerSecond;
}

function pruneStarts(nowMs: number): void {
  while (recentStarts.length > 0 && recentStarts[0] <= nowMs - WINDOW_MS) recentStarts.shift();
}

/** May another background spawn START right now? */
export function backgroundSpawnAllowed(nowMs: number = Date.now()): boolean {
  if (backgroundPerSecond === Infinity) return true;
  pruneStarts(nowMs);
  return recentStarts.length < backgroundPerSecond;
}

/** Count a background spawn as started. */
export function recordBackgroundSpawnStart(nowMs: number = Date.now()): void {
  if (backgroundPerSecond !== Infinity) recentStarts.push(nowMs);
}

/** Milliseconds until the budget admits another background spawn (0 when it already would). */
export function msUntilBackgroundSpawnAllowed(nowMs: number = Date.now()): number {
  if (backgroundSpawnAllowed(nowMs)) return 0;
  return Math.max(1, recentStarts[0] + WINDOW_MS - nowMs);
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

const INFRASTRUCTURE_FRAME = /[\\/]git-(?:exec|spawn-governor)\.[tj]s|[\\/]git-service[\\/]|git\.service|node:internal|node_modules/;
/**
 * The same plumbing by FUNCTION name. In the bundled dist every frame is `cli/index.js`, so the
 * path test above never matches; the names survive bundling (esbuild keeps function names).
 */
const INFRASTRUCTURE_FUNCTION = /^\s*at (?:async )?(?:new )?(?:noteGitSpawnCaller|scheduleSpawn|spawnBuffered|gitExec\w*|gitStream|runWithGitPriority|callerFromStack)\b/;
const FRAME_LOCATION = /\(?((?:file:\/\/\/?)?[^\s()]+?):(\d+):\d+\)?\s*$/;
const FRAME_FUNCTION = /^\s*at (?:async )?([^\s(]+) \(/;
/** A bundle's file name says nothing about the caller, so the function name is added there. */
const BUNDLE_FILE = /^index\.[cm]?js$/;

/** `dir/file.ts:123` of the first stack frame that is not git plumbing, or null. */
export function callerFromStack(stack: string | undefined): string | null {
  if (!stack) return null;
  for (const line of stack.split("\n").slice(1)) {
    if (INFRASTRUCTURE_FRAME.test(line) || INFRASTRUCTURE_FUNCTION.test(line)) continue;
    const m = FRAME_LOCATION.exec(line);
    if (!m) continue;
    const parts = m[1].split(/[\\/]/);
    const where = `${parts.slice(-2).join("/")}:${m[2]}`;
    const fn = FRAME_FUNCTION.exec(line)?.[1];
    return fn && BUNDLE_FILE.test(parts[parts.length - 1]) ? `${where} ${fn}` : where;
  }
  return null;
}

/** Remember that `subcommand` was queued by the caller on the current stack. Cheap next to a spawn. */
export function noteGitSpawnCaller(subcommand: string | null): void {
  const caller = callerFromStack(new Error().stack) ?? "(unknown)";
  let key = `${caller} git:${subcommand ?? "unknown"}`;
  if (!callerCounts.has(key) && callerCounts.size >= MAX_TRACKED_CALLERS) key = OTHER_CALLER;
  callerCounts.set(key, (callerCounts.get(key) ?? 0) + 1);
}

export interface GitSpawnCallerCount {
  caller: string;
  count: number;
}

/** The busiest `limit` callers since the last drain, then start a fresh window. */
export function drainGitSpawnCallers(limit = 5): GitSpawnCallerCount[] {
  const top = [...callerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([caller, count]) => ({ caller, count }));
  callerCounts = new Map();
  return top;
}

/** TEST-ONLY — restore the default (unbudgeted, empty) state. */
export function __resetGitSpawnGovernorForTests(): void {
  backgroundPerSecond = Infinity;
  recentStarts = [];
  callerCounts = new Map();
}
