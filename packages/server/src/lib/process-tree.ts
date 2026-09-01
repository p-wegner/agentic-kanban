import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isPidAlive } from "./pid.js";

const execFileAsync = promisify(execFile);

/**
 * "Is the process TREE rooted at this pid still alive?" — the question `isPidAlive` cannot
 * answer, and the one #968 turned on.
 *
 * `lib/pid.ts` probes ONE pid. That is the right question for a process the board spawned
 * and holds, but it is the wrong question for what the board actually cares about: whether
 * an AGENT is still working in a worktree. A detached stream-json launch on Windows does not
 * put the working `claude.exe` at the pid we spawned — the spawned child can exit (or be
 * reaped) while its descendants keep running, reparented. Observed live: board session
 * 62c6722d was recorded `completed` exit 0 at 01:12:48Z while its claude.exe (pid 31344)
 * went on opening a new transcript, editing files and running the verify chain for another
 * 20 minutes. The board saw an exit event and believed it.
 *
 * So `exit` means "the handle we held closed", never "the work stopped". Everything here
 * exists to let a caller tell those two apart.
 *
 * ## Rules this module holds to
 *
 * - **Read-only.** Nothing here kills anything. The kill paths (`agent.service.ts`'s
 *   `killProcessTree`, `machine-capacity.js`'s `killTree`) already exist and are deliberately
 *   separate: a probe that can also kill is a probe nobody dares call on a hunch.
 * - **Never throws, and says when it does not know.** Every answer is a
 *   {@link TreeLiveness} verdict with an `unknown` arm. That is not defensive padding — a
 *   process enumeration can fail (no PowerShell, an EPERM sweep, a 5s budget blown) and the
 *   two guards built on this both treat `unknown` as "do not act", so silently collapsing it
 *   into `dead` would reinstate exactly the false `completed` this module exists to prevent.
 * - **Bounded.** Enumeration is one subprocess with a hard timeout and a bounded walk depth;
 *   it runs on a session exit and on a relaunch, never in a loop.
 */

/**
 * Three-valued, for the reason `isPidAlive`'s EPERM case is: the interesting failure is the
 * one where we cannot see, and a caller that cannot distinguish it from "gone" will act on
 * no evidence. `pids` is populated only for `alive` and names what was found, so a refusal
 * can tell the operator which processes to look at rather than just asserting there are some.
 */
export interface TreeLiveness {
  liveness: "alive" | "dead" | "unknown";
  /** Live pids in the tree (root included when it is itself alive). Empty unless `alive`. */
  pids: number[];
  /** Human-readable why, for logs and for the text of a refusal. */
  reason: string;
}

/** One row of the OS process table: a pid and who its parent was. */
export interface ProcessTableRow {
  pid: number;
  ppid: number;
}

/** Hard bound on the enumeration subprocess. A probe must never become the thing that hangs. */
const ENUMERATE_TIMEOUT_MS = 5000;

/**
 * How deep the parent→child walk goes. A real agent tree is shallow (shim → CLI → helpers);
 * the bound exists so a pid-recycling cycle in the table cannot spin. Same depth as
 * `machine-capacity.js`'s killTree, for the same reason.
 */
const MAX_TREE_DEPTH = 6;

/**
 * Snapshot the OS process table as (pid, ppid) pairs.
 *
 * Returns `null` when the enumeration could not be performed at all (spawn failed, non-zero
 * exit, blown timeout). An empty result is equally uninformative and is handled by
 * {@link probeProcessTree}'s empty-table rule, which sees injected enumerators too.
 */
export async function enumerateProcesses(): Promise<ProcessTableRow[] | null> {
  // ASYNC on purpose. A synchronous enumeration is a PowerShell spawn on Windows — up to the
  // full timeout below — and both callers run on a session exit or a launch request, i.e. on
  // the server's event loop. Blocking it there would stall every other session's output
  // streaming to diagnose one. Nothing here needs to be synchronous.
  let stdout: string;
  try {
    const result = process.platform === "win32"
      ? await execFileAsync(
          "powershell",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }",
          ],
          { encoding: "utf8", windowsHide: true, timeout: ENUMERATE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
        )
      : await execFileAsync("ps", ["-eo", "pid=,ppid="], {
          encoding: "utf8",
          windowsHide: true,
          timeout: ENUMERATE_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
        });
    stdout = result.stdout;
  } catch {
    // Spawn failure, non-zero exit, blown timeout, blown buffer — all of them mean the same
    // thing to a caller: we could not read the table.
    return null;
  }

  const rows: ProcessTableRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    rows.push({ pid, ppid });
  }
  // A parse that yielded nothing is handled by `probeProcessTree`'s empty-table rule, so it
  // is not re-decided here — one rule, one place, and an injected enumerator obeys it too.
  return rows;
}

/**
 * Collect the pids descended from `rootPid` in a process-table snapshot.
 *
 * Pure, so the walk is testable against a hand-written table without spawning anything — and
 * the walk is the part with the interesting bug (depth, cycles, self-parenting).
 * `rootPid` itself is never included; the caller decides whether the root's own liveness
 * counts, because for #968 it explicitly does not (the root is the process that just exited).
 */
export function descendantsOf(rootPid: number, table: ProcessTableRow[]): number[] {
  const byParent = new Map<number, number[]>();
  for (const row of table) {
    // Self-parenting (pid 0 on Windows, an artifact of a recycled id) would loop forever.
    if (row.pid === row.ppid) continue;
    const siblings = byParent.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else byParent.set(row.ppid, [row.pid]);
  }

  const found = new Set<number>();
  let frontier = [rootPid];
  for (let depth = 0; depth < MAX_TREE_DEPTH && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const parent of frontier) {
      for (const child of byParent.get(parent) ?? []) {
        if (child === rootPid || found.has(child)) continue;
        found.add(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return [...found];
}

/**
 * Is anything from the process tree rooted at `pid` still running?
 *
 * The root's own liveness counts too: a caller asking this after an `exit` event has a root
 * that is gone by definition, so including it costs nothing there, while a caller asking it
 * about a session it believes is running wants the straightforward answer.
 *
 * `enumerate` is injectable for the same reason every sweep here takes its probe: the
 * verdict logic is the part worth testing, and it must be testable without a real OS.
 */
export async function probeProcessTree(
  pid: number | null | undefined,
  opts: {
    enumerate?: () => Promise<ProcessTableRow[] | null> | ProcessTableRow[] | null;
    checkPid?: (pid: number) => boolean;
  } = {},
): Promise<TreeLiveness> {
  if (!pid || !Number.isFinite(pid) || pid <= 0) {
    return { liveness: "dead", pids: [], reason: "no pid recorded for this session" };
  }
  const enumerate = opts.enumerate ?? enumerateProcesses;
  const checkPid = opts.checkPid ?? isPidAlive;

  const rootAlive = checkPid(pid);
  // A rejected enumeration is the same fact as a failed one: we cannot see. Never let it
  // propagate — a probe that throws at its caller is a probe every caller wraps in a
  // try/catch of its own, and that is where the `unknown` arm gets quietly lost.
  const table = await Promise.resolve()
    .then(enumerate)
    .catch(() => null);
  // An EMPTY table is treated identically to a failed one, and the check lives here rather
  // than only in `enumerateProcesses` so an injected enumerator obeys the same rule: no OS has
  // zero processes, so an empty result means the output shape changed under us, not that the
  // machine is idle. Reading it as "nothing is running" is how a guard concludes a live tree
  // is dead — the exact inversion #968 is about.
  if (!table || table.length === 0) {
    // We could not enumerate. If the ROOT is alive we still know enough to answer `alive`;
    // otherwise we genuinely cannot see the descendants and must say so rather than guess.
    return rootAlive
      ? { liveness: "alive", pids: [pid], reason: `pid ${pid} is alive` }
      : { liveness: "unknown", pids: [], reason: "could not enumerate the process table" };
  }

  const live = descendantsOf(pid, table).filter((child) => checkPid(child));
  if (rootAlive) live.unshift(pid);
  if (live.length === 0) {
    return { liveness: "dead", pids: [], reason: `pid ${pid} and its descendants are gone` };
  }
  return {
    liveness: "alive",
    pids: live,
    reason: rootAlive
      ? `pid ${pid} is alive (${live.length} process(es) in its tree)`
      : `pid ${pid} exited but ${live.length} descendant process(es) survive it: ${live.join(", ")}`,
  };
}
