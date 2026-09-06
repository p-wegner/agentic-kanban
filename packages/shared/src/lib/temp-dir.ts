import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, lstatSync } from "node:fs";
import { readdir, readFile, rm, lstat } from "node:fs/promises";
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
export const TEMP_DIR_OWNER_FILE = ".kanban-temp-owner.json";

/** Only ESRCH proves death; access denied and PID reuse conservatively retain the root. */
function ownerMayBeAlive(text: string): boolean {
  try {
    const owner = JSON.parse(text);
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return true;
    try { process.kill(owner.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  } catch { return true; }
}

function retainOwner(root: string, retainUnowned = false): boolean {
  try { return ownerMayBeAlive(readFileSync(join(root, TEMP_DIR_OWNER_FILE), "utf8")); }
  catch (error) { return retainUnowned || (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

function writeOwner(root: string): void {
  writeFileSync(join(root, TEMP_DIR_OWNER_FILE), JSON.stringify({ pid: process.pid }));
}

export interface ManagedTempDir {
  /** Absolute path of the created directory. */
  readonly path: string;
  /**
   * Remove the directory and everything in it. Idempotent, never throws.
   * Returns true when the directory is gone afterwards (including "was already gone").
   */
  dispose(): boolean;
  /** Production cleanup: recursive filesystem work never blocks the server event loop. */
  disposeAsync(): Promise<boolean>;
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
  try { writeOwner(path); }
  catch (error) {
    // Creation failed before the caller received its disposer; this new root is ours alone.
    try { rmSync(path, { recursive: true, force: true }); } catch { /* preserve creation error */ }
    throw error;
  }
  let disposed = false;
  return {
    path,
    async disposeAsync(): Promise<boolean> {
      if (disposed) return true;
      try {
        await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        disposed = true;
        return true;
      } catch {
        // Recursive removal may have removed the marker before encountering a locked file.
        try { writeOwner(path); } catch { /* unowned roots are retained by production sweeps */ }
        return false;
      }
    },
    dispose(): boolean {
      if (disposed) return true;
      try {
        // `force` swallows ENOENT (already gone); `maxRetries` covers the Windows
        // "file in use by another process" window that a just-exited child leaves behind.
        rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        disposed = true;
        return true;
      } catch {
        try { writeOwner(path); } catch { /* unowned roots are retained by production sweeps */ }
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
    await dir.disposeAsync();
  }
}

export interface SweepTempDirsOptions {
  /** Production boards cannot prove legacy roots belong to a dead process. */
  retainUnowned?: boolean;
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
 * `SIGKILL`. Owner PID liveness protects concurrent managed roots independently of age.
 * The age cutoff is only a grace period. Production callers retain unowned legacy roots,
 * because an older board may still use them; explicit legacy cleanup can opt into age alone.
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
      const st = lstatSync(full);
      if (!st.isDirectory()) continue;
      mtimeMs = st.mtimeMs;
    } catch {
      continue; // vanished between readdir and stat — someone else reaped it
    }
    if (mtimeMs >= cutoff) continue;
    if (retainOwner(full, options.retainUnowned)) continue;
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

/** Async sweep; production callers set retainUnowned to protect older boards' legacy roots. */
export async function sweepStaleTempDirsAsync(prefix: string, options: SweepTempDirsOptions = {}): Promise<SweepTempDirsResult> {
  assertNamespacedPrefix(prefix);
  const root = options.root ?? tmpdir();
  const cutoff = (options.nowMs ?? Date.now()) - (options.olderThanMs ?? 60 * 60_000);
  const result: SweepTempDirsResult = { matched: 0, removed: 0, failed: 0, truncated: false };
  let entries: string[];
  try { entries = await readdir(root); } catch { return result; }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const full = join(root, name);
    try {
      const st = await lstat(full);
      if (!st.isDirectory() || st.mtimeMs >= cutoff) continue;
      try {
        if (ownerMayBeAlive(await readFile(join(full, TEMP_DIR_OWNER_FILE), "utf8"))) continue;
      } catch (error) {
        if (options.retainUnowned || (error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
    } catch { continue; }
    result.matched++;
    if (result.removed >= (options.maxRemovals ?? 5_000)) {
      result.truncated = true;
      break;
    }
    try {
      await rm(full, { recursive: true, force: true, maxRetries: 1, retryDelay: 50 });
      result.removed++;
    } catch { result.failed++; }
  }
  return result;
}
