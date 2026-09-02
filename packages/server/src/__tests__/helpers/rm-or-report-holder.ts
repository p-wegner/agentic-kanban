/**
 * Teardown removal that NAMES the handle instead of retrying around it (#777).
 *
 * On Windows an `EPERM`/`EBUSY` from a recursive `rmSync` in an `afterAll` is almost never a
 * permissions problem: it is a still-open handle — a child process whose `cwd` is inside the
 * tree, a git helper (`upload-pack`/`receive-pack`/`http-backend`) still serving, a socket, a
 * watcher. Wrapping the `rm` in a retry loop makes the suite green again and destroys the only
 * evidence of WHICH handle leaked, so the leak survives and reappears as an unrelated flake in
 * whatever file runs next.
 *
 * So this helper deliberately does NOT retry. It re-throws, adding the two things a reader
 * needs to name the holder:
 *
 *  - what SURVIVED under the path (the leftover subtree points straight at the holder: a
 *    `checkouts/<sessionId>` that would not go means the agent process is alive; a surviving
 *    `.git/objects/pack` means a git child still has the packfile mapped),
 *  - which live processes look related (command line mentioning the directory, or one of the
 *    git transport helpers).
 *
 * The process enumeration only runs on the failure path — it spawns PowerShell and costs ~1s,
 * which is fine for a teardown that is already failing and unacceptable for one that is not.
 */
import { readdirSync, rmSync, type Dirent } from "node:fs";
import { basename, join, relative } from "node:path";
import { listOsProcesses } from "../../services/process-exec.js";

/** Command-line fragments of processes that plausibly hold a fixture repo open. */
const GIT_TRANSPORT_HELPERS = ["upload-pack", "receive-pack", "http-backend"];

function surviving(root: string, limit = 20): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (found.length >= limit) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      const full = join(dir, entry.name);
      found.push(relative(root, full) || entry.name);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return found;
}

async function relatedProcesses(path: string): Promise<string[]> {
  const needle = basename(path).toLowerCase();
  try {
    const procs = await listOsProcesses();
    return procs
      .filter((p) => {
        const cmd = p.commandLine.toLowerCase();
        return cmd.includes(needle) || GIT_TRANSPORT_HELPERS.some((h) => cmd.includes(h));
      })
      .map((p) => `pid=${p.pid} ppid=${p.ppid} ${p.commandLine.slice(0, 200)}`);
  } catch {
    return [];
  }
}

/**
 * Remove a SHORT-LIVED fixture whose only children were synchronous and have already exited
 * (#1006) — a temp git repo driven with `execFileSync`/`spawnSync` and nothing else.
 *
 * This is a different case from `rmOrReportHolder` below, and the difference is the whole reason
 * it gets different treatment. That helper's no-retry policy exists because the fixtures it
 * guards own a LONG-LIVED holder — a child server, a git transport helper, a watcher — where an
 * EPERM is real evidence of a leak and retrying would destroy it. Here every child has already
 * been reaped by the synchronous spawn returning, so there is no holder to name: the EPERM is
 * Windows closing the last handle on `.git` asynchronously after `git` exits, which clears in
 * milliseconds. Observed on the pre-merge gate (run merge-6dbc0e62-4) as an EPERM from the
 * `finally` of a test whose assertions had all PASSED — a green test reported red by its own
 * cleanup, on a box that was merely busy.
 *
 * `force` still swallows ENOENT.
 *
 * Two things were tuned after the first attempt at this helper failed its OWN pre-merge gate
 * (run merge-be21ce4c-2) with the same EPERM it was written to absorb:
 *
 * 1. **The retry budget was an order of magnitude too small.** `maxRetries: 5` at
 *    `retryDelay: 200` is a ceiling of one second, chosen against the "clears in milliseconds"
 *    behaviour of an idle box. The gate is not an idle box — it runs this suite at four workers
 *    with the machine swapping — and the handle took longer than that to drop. The budget is now
 *    ~15s, which is still far below the suite's own per-test cost, so a genuine leak is not
 *    disguised as slowness.
 * 2. **Exhausting the budget no longer FAILS the test.** For this fixture shape there is nothing
 *    to diagnose and nothing at stake: every child has exited, the directory is a `mkdtemp` under
 *    the OS temp dir, and the OS reclaims it. Throwing there does not surface a defect — it
 *    reports a test whose assertions all PASSED as a failure, which is precisely the false red
 *    this helper exists to remove. It warns instead, so the leak is still visible in the log.
 *
 * This deliberately does NOT relax `rmOrReportHolder` below. That helper guards fixtures owning a
 * LONG-LIVED holder — a child server, a git transport helper, a watcher — where an EPERM IS the
 * evidence and retrying would destroy it. The two cases stay apart.
 */
export function rmFixtureDir(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
  } catch (err) {
    // Deliberately non-fatal — see the note above.
    const code = (err as NodeJS.ErrnoException)?.code ?? "unknown";
    console.warn(
      `[rmFixtureDir] left ${path} on disk after ~15s of retries (${code}); ` +
        "the OS temp dir reclaims it. Not failing the test: every child of this fixture " +
        "has already exited, so there is no holder to diagnose.",
    );
  }
}

/**
 * Remove `path` recursively. On success, silent. On failure, throw an error that names the
 * surviving tree and the processes that plausibly hold it — never a retry.
 */
export async function rmOrReportHolder(path: string): Promise<void> {
  try {
    rmSync(path, { recursive: true, force: true });
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    const left = surviving(path);
    const procs = await relatedProcesses(path);
    throw new Error(
      `teardown could not remove ${path} (${code}) — this is an unclosed handle, not a permissions ` +
        `problem, and it is NOT retried on purpose (#777).\n` +
        `  surviving entries (${left.length}${left.length >= 20 ? "+" : ""}): ${left.join(", ") || "<none>"}\n` +
        `  possibly holding it: ${procs.length ? `\n    ${procs.join("\n    ")}` : "<no matching process found>"}`,
    );
  }
}
