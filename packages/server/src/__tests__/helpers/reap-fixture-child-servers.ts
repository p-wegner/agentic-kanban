/**
 * Vitest `globalSetup` for the server package — fixture child-server / temp-dir reaper (#352).
 *
 * Measured on this dev box: **22 live orphaned `node serve.mjs` processes** spawned out of
 * `%TEMP%\plugin-test-plugin-<rand>\`, with start times spanning the window in which the test
 * suites ran and nothing still running them, plus **330 leftover `plugin-test-plugin-*`
 * directories** going back a week. Disk was only 0.4 MB, so a size alarm would never see it — the
 * processes are the damage. Each orphan holds a fixture port, which can make a later test fail or
 * pass for reasons unrelated to the code under test, and holds its temp dir as `cwd`, which is why
 * the suites' `rmSync` swallowed EBUSY and the directories piled up.
 *
 * Why `globalSetup` rather than `setupFiles`: `setupFiles` runs once PER FORK
 * (`maxWorkers = cpus/2`), so a sweep there would run several times concurrently and could reap a
 * sibling fork's live fixture. `globalSetup` runs exactly once before any fork starts, and its
 * returned function runs exactly once after the last one finishes — so the run is self-healing on
 * a machine that already has orphans (the state most dev machines are in), AND leaves none behind.
 *
 * The interrupted-run case is the important half: a killed vitest worker never reaches its
 * `afterEach`, so only a sweep at the START of the NEXT run can recover from it.
 *
 * Safety: this mirrors the production `reapParentlessChildServers` guard exactly — a process is
 * killed only when its command line matches a known fixture-server marker AND its parent PID is
 * not live. A child whose parent is alive is someone's running plugin view, possibly in another
 * worktree, and is left strictly alone. It is deliberately self-contained (no DB, no server
 * imports) so `globalSetup` cannot drag the application graph into the test bootstrap.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listOsProcesses, taskkillTree } from "../../services/process-exec.js";

/** Command-line markers of servers only ever spawned BY a test fixture. */
const FIXTURE_SERVER_MARKERS = ["serve.mjs"];

/** Temp-directory prefixes created by the plugin test fixtures. */
const FIXTURE_TEMP_PREFIXES = [
  "plugin-test-plugin-",
  "plugin-test-parent-",
  "plugin-test-empty-",
  "plugin-encoding-test-",
  "plugin-encoding-loop-",
  "view-ready-plugin-",
  "view-ready-repo-",
  "view-race-plugin-",
  "view-race-repo-",
];

/** Don't touch a directory younger than this — it may belong to a concurrently running suite. */
const MIN_TEMP_DIR_AGE_MS = 60_000;

async function reapOrphanedFixtureServers(): Promise<number> {
  let procs: Awaited<ReturnType<typeof listOsProcesses>>;
  try {
    procs = await listOsProcesses();
  } catch {
    return 0; // enumeration is best-effort; never fail the test run over hygiene
  }
  const livePids = new Set(procs.map((p) => p.pid));
  const orphans = procs.filter((proc) => {
    if (proc.pid === process.pid) return false;
    const cmd = proc.commandLine || "";
    if (!FIXTURE_SERVER_MARKERS.some((marker) => cmd.includes(marker))) return false;
    // ppid 0 means "unknown" from the enumerator, not "orphan" — never guess.
    if (!proc.ppid) return false;
    return !livePids.has(proc.ppid);
  });

  let killed = 0;
  for (const orphan of orphans) {
    try {
      if (process.platform === "win32") await taskkillTree(orphan.pid);
      else process.kill(orphan.pid, "SIGKILL");
      killed++;
    } catch { /* already gone */ }
  }
  if (killed > 0) console.log(`[test-reaper] killed ${killed}/${orphans.length} orphaned fixture server process(es)`);
  return killed;
}

async function reapStaleFixtureTempDirs(): Promise<number> {
  const base = tmpdir();
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - MIN_TEMP_DIR_AGE_MS;
  let removed = 0;
  for (const name of entries) {
    if (!FIXTURE_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const full = join(base, name);
    try {
      const info = await stat(full);
      if (!info.isDirectory() || info.mtimeMs > cutoff) continue;
      await rm(full, { recursive: true, force: true });
      removed++;
    } catch { /* locked by a survivor, or already gone — best effort */ }
  }
  if (removed > 0) console.log(`[test-reaper] removed ${removed} stale fixture temp dir(s)`);
  return removed;
}

async function sweep(): Promise<void> {
  // Processes first: an orphan holds its temp dir open, so removing the dir cannot succeed until
  // the process holding it is gone.
  await reapOrphanedFixtureServers();
  await reapStaleFixtureTempDirs();
}

export async function setup(): Promise<void> {
  await sweep();
}

export async function teardown(): Promise<void> {
  await sweep();
}
