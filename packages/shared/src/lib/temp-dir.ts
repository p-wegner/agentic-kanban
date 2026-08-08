import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One owner for every throwaway directory this codebase puts in `%TEMP%` (#362/#364).
 *
 * The motivating measurement: 8,448 live `kanban-*` directories across ~14 distinct
 * prefixes, spanning a month and still growing, because creation and removal were
 * written by different people in different places — and in most places removal was
 * never written at all. `mkdtempSync(join(tmpdir(), "prefix-"))` is a one-liner;
 * remembering to `rmSync` it on every one of a function's eight early returns is not.
 * So creation here HANDS BACK the disposer, which makes the pairing local and
 * reviewable, and `withTempDir` makes it impossible to forget.
 *
 * Two things this deliberately does NOT do:
 *
 * 1. **It does not throw on a failed removal.** On Windows a directory cannot be
 *    removed while any process holds it as its cwd, and #352 established that this
 *    is a real cause here rather than a hypothetical: teardown *was* running and
 *    simply could not succeed while a surviving grandchild process sat in the
 *    directory. A disposer that throws would turn a leaked directory into a failed
 *    test, which is strictly worse. `dispose()` reports success as a boolean so a
 *    caller that cares can log it; nobody has to handle it.
 * 2. **It does not register a `process.on("exit")` hook.** An exit hook can only run
 *    synchronous work in a process that is already tearing down, it does not run on
 *    `SIGKILL`, and — the actual reason — it would make a leak invisible until the
 *    very end of a run, which is exactly the shape of bug that produced the 8,448.
 *    `sweepStaleTempDirs` at the START of a run is the recovery mechanism instead:
 *    it is idempotent, it works on a machine that already has the backlog, and it
 *    works after a `SIGKILL` too.
 *
 * Node-only (`node:fs`, `node:os`) — never value-export this from the client-reachable
 * `@agentic-kanban/shared/lib` barrel. Import it via its deep path:
 * `@agentic-kanban/shared/lib/temp-dir`.
 */

/** Every temp-dir prefix this codebase owns must start with this, so a sweep can find them all. */
export const TEMP_DIR_NAMESPACE = "kanban-";

export interface ManagedTempDir {
  /** Absolute path of the created directory. */
  readonly path: string;
  /**
   * Remove the directory and everything in it. Idempotent, never throws.
   * Returns true when the directory is gone afterwards (including "was already gone").
   */
  dispose(): boolean;
}

function assertNamespacedPrefix(prefix: string): void {
  if (!prefix.startsWith(TEMP_DIR_NAMESPACE)) {
    throw new Error(
      `Temp-dir prefix "${prefix}" must start with "${TEMP_DIR_NAMESPACE}" so sweepStaleTempDirs can find and reap it`,
    );
  }
}

/**
 * Create a uniquely named directory under the OS temp dir and return it together with
 * its disposer. The prefix must live in the `kanban-` namespace: a directory a sweep
 * cannot recognise is a directory that leaks forever the moment its disposer is missed.
 */
export function createManagedTempDir(prefix: string): ManagedTempDir {
  assertNamespacedPrefix(prefix);
  const path = mkdtempSync(join(tmpdir(), prefix));
  let disposed = false;
  return {
    path,
    dispose(): boolean {
      if (disposed) return true;
      try {
        // `force` swallows ENOENT (already gone); `maxRetries` covers the Windows
        // "file in use by another process" window that a just-exited child leaves behind.
        rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        disposed = true;
        return true;
      } catch {
        // See limit 1 in the module header: a directory we cannot remove is a leak to
        // report, never a failure to propagate into the caller's control flow.
        return false;
      }
    },
  };
}

/**
 * Run `body` with a managed temp dir and dispose it afterwards, on every exit path.
 * The preferred form: it is the one shape where a new early `return` inside `body`
 * cannot reintroduce the leak.
 */
export async function withTempDir<T>(prefix: string, body: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = createManagedTempDir(prefix);
  try {
    return await body(dir.path);
  } finally {
    dir.dispose();
  }
}

export interface SweepTempDirsOptions {
  /** Only reap entries whose mtime is older than this many ms. Defaults to 1 hour. */
  olderThanMs?: number;
  /** Directory to sweep. Defaults to the OS temp dir. */
  root?: string;
  /** Clock injection for tests. */
  nowMs?: number;
  /** Stop after this many removals, so a machine with 8,448 of them cannot hang a test run. */
  maxRemovals?: number;
}

export interface SweepTempDirsResult {
  /** Entries that matched the prefix and the age cutoff. */
  matched: number;
  /** Entries actually removed. */
  removed: number;
  /** Entries that matched but could not be removed (held open, permissions). */
  failed: number;
  /** True when `maxRemovals` cut the sweep short — more remain for the next run. */
  truncated: boolean;
}

/**
 * Best-effort reaper for directories a previous run left behind (#364).
 *
 * This is the half that makes the suite self-healing rather than merely
 * well-behaved-from-now-on: the acceptance test for #364 is that the count does not
 * grow after a **deliberately interrupted** run, and no amount of `finally` covers a
 * `SIGKILL`. Ages the cutoff so it can never delete a directory a CONCURRENTLY
 * RUNNING sibling process (another worktree's test run, another agent) is using —
 * one hour is far longer than any fixture's lifetime and far shorter than the month
 * of accumulation measured.
 *
 * Never throws: an unreadable temp root, a vanished entry mid-iteration and a locked
 * directory are all normal here.
 */
export function sweepStaleTempDirs(prefix: string, options: SweepTempDirsOptions = {}): SweepTempDirsResult {
  assertNamespacedPrefix(prefix);
  const root = options.root ?? tmpdir();
  const cutoff = (options.nowMs ?? Date.now()) - (options.olderThanMs ?? 60 * 60_000);
  const maxRemovals = options.maxRemovals ?? 5_000;
  const result: SweepTempDirsResult = { matched: 0, removed: 0, failed: 0, truncated: false };

  let entries: string[];
  try {
    // Names only: `withFileTypes` on a %TEMP% holding a quarter of a million entries
    // is measurably slower, and the `statSync` below has to happen per candidate anyway.
    entries = readdirSync(root);
  } catch {
    return result;
  }

  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const full = join(root, name);
    let mtimeMs: number;
    try {
      const st = statSync(full);
      if (!st.isDirectory()) continue;
      mtimeMs = st.mtimeMs;
    } catch {
      continue; // vanished between readdir and stat — someone else reaped it
    }
    if (mtimeMs >= cutoff) continue;
    result.matched++;
    if (result.removed >= maxRemovals) {
      result.truncated = true;
      break;
    }
    try {
      rmSync(full, { recursive: true, force: true, maxRetries: 1, retryDelay: 50 });
      result.removed++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
