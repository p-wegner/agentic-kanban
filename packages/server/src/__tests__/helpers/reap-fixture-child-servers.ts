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

/** Don't touch a directory younger than this — it may belong to a concurrently running suite. */
const MIN_TEMP_DIR_AGE_MS = 60_000;

/**
 * A namespace this sweep may reap, with the minimum age it must reach first (#364).
 *
 * #352 fixed one prefix family and #362 fixed one call site, but the leak is systemic: measured
 * at **8,448 live `kanban-*` directories across ~14 distinct fixture prefixes**, oldest a month
 * old and the newest created minutes before the ticket was filed. There are ~250 `mkdtemp` call
 * sites across the test suites; patching each one's teardown is 250 chances to miss one, and
 * teardown does not run at all on the case that matters — a killed run. So the sweep owns the
 * NAMESPACE, not the individual prefixes.
 *
 * Two ages, deliberately:
 *
 * - The plugin prefixes stay at 60s. They are paired with a process reap (an orphan `serve.mjs`
 *   holds its dir as cwd), so reaping them promptly is the whole point of #352's fix.
 * - The broad `kanban-`/`ak-` namespaces get **two hours**, because a prefix list is a whitelist
 *   of things we understand and a namespace is not: `kanban-*` also covers dirs created by a
 *   concurrently running suite in ANOTHER worktree of this repo, and by the long-lived
 *   `kanban-api-fixture-*` repo a fork keeps for its whole duration. Two hours is comfortably
 *   longer than any full suite run measured here (~40 min) and vastly shorter than the month of
 *   accumulation, so the count stops growing across runs without ever deleting live state.
 *
 * NOT swept: `kanban-session-*.out` and `kanban-verify-*.log` are FILES, not directories, and
 * `statSync(...).isDirectory()` excludes them — session transcripts are read by the running
 * server and reaping them would break live output.
 */
export const SWEPT_TEMP_NAMESPACES: Array<{ prefixes: string[]; minAgeMs: number }> = [
  {
    minAgeMs: MIN_TEMP_DIR_AGE_MS,
    prefixes: [
      "plugin-test-plugin-",
      "plugin-test-parent-",
      "plugin-test-empty-",
      "plugin-encoding-test-",
      "plugin-encoding-loop-",
      "view-ready-plugin-",
      "view-ready-repo-",
      "view-race-plugin-",
      "view-race-repo-",
    ],
  },
  { minAgeMs: 2 * 60 * 60_000, prefixes: ["kanban-", "ak-"] },
];

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

/**
 * Cap removals per sweep. On the measured machine `%TEMP%` holds ~247,000 directories and
 * enumerating it takes over 120 seconds — slow enough that it has already timed out diagnostic
 * commands. A sweep that tried to remove all 8,448 in one go would add minutes to the front of
 * every test run; the cap drains the backlog over successive runs instead, while the steady
 * state (a handful per run) always fits in one pass.
 */
const MAX_REMOVALS_PER_SWEEP = 500;

export function matchedNamespace(name: string): { minAgeMs: number } | null {
  for (const ns of SWEPT_TEMP_NAMESPACES) {
    if (ns.prefixes.some((prefix) => name.startsWith(prefix))) return ns;
  }
  return null;
}

async function reapStaleFixtureTempDirs(): Promise<number> {
  const base = tmpdir();
  let entries: string[];
  try {
    // ONE enumeration for every namespace. Splitting it per prefix family would pay the
    // 120-second `%TEMP%` scan twice.
    entries = await readdir(base);
  } catch {
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  let failed = 0;
  let truncated = false;
  for (const name of entries) {
    const ns = matchedNamespace(name);
    if (!ns) continue;
    if (removed >= MAX_REMOVALS_PER_SWEEP) { truncated = true; break; }
    const full = join(base, name);
    try {
      const info = await stat(full);
      // Directories only — `kanban-session-*.out` transcripts are files the running server reads.
      if (!info.isDirectory() || info.mtimeMs > now - ns.minAgeMs) continue;
      await rm(full, { recursive: true, force: true, maxRetries: 1 });
      removed++;
    } catch {
      // #352's root cause: a surviving grandchild holding the dir as its cwd makes removal
      // impossible however well the teardown is written. Counted so a recurring failure is
      // visible instead of looking like a sweep that simply found nothing.
      failed++;
    }
  }
  if (removed > 0 || failed > 0) {
    console.log(
      `[test-reaper] removed ${removed} stale fixture temp dir(s)`
      + (failed > 0 ? `, ${failed} could not be removed (still held open?)` : "")
      + (truncated ? `, capped at ${MAX_REMOVALS_PER_SWEEP} — more remain for the next run` : ""),
    );
  }
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
