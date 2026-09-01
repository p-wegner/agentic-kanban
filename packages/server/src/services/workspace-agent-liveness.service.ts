import { enumerateProcesses, probeProcessTree, type ProcessTableRow, type TreeLiveness } from "../lib/process-tree.js";

/**
 * "Is an agent still working in this worktree?" — asked at RELAUNCH time (#968).
 *
 * The board's readers of "is this workspace busy" all consult a session's recorded STATUS,
 * and that is what failed: session 62c6722d was recorded `completed` exit 0 while its
 * claude.exe kept editing files and running the verify chain for twenty more minutes. The
 * workspace showed no running session, so the driving session relaunched — which is exactly
 * what `POST /:id/launch` is for — and two agents co-edited one branch. Nothing interleaved
 * into a commit only because both agents happened to notice each other and one held back.
 *
 * **The caller cannot see the zombie, so the API has to.** A recorded status is the board's
 * BELIEF about a process; this asks the operating system instead. It is deliberately a
 * separate question from `sessionStatus` rather than a correction to it — the stream really
 * did close, and rewriting that record would break every reader of the exit code.
 *
 * ## Which sessions are probed, and why not just the last one
 *
 * Every session of the workspace that holds a host pid, whatever its recorded status. The
 * defect is precisely that the status is unreliable, so filtering by it would reintroduce
 * the bug: the session that survived was `completed`, the state a status filter would most
 * obviously skip. It is a handful of rows and one process-table snapshot.
 *
 * A session dispatched to a fleet worker has no host pid by construction. It is skipped
 * rather than treated as absent evidence, because its liveness is the worker's question
 * (`probeRemoteSessionLiveness`) and answering it from the board's own process table would
 * be answering about the wrong machine.
 */

/** A live agent tree found under a workspace, named well enough to act on. */
export interface LiveAgentTree {
  sessionId: string;
  pid: number;
  /** Live pids in that session's tree — what an operator would inspect or kill. */
  pids: number[];
  reason: string;
}

export interface WorkspaceAgentLiveness {
  /**
   * Three-valued for the same reason the process probe is: `unknown` means the process table
   * could not be read, and a caller that collapses it into "nothing is running" has decided
   * to relaunch on no evidence — the exact failure this guard exists to prevent.
   */
  verdict: "clear" | "live" | "unknown";
  /** Populated only for `live`. */
  trees: LiveAgentTree[];
  reason: string;
}

/** The subset of a session row this needs. Structural, so callers pass full rows unchanged. */
export interface SessionPidRow {
  id: string;
  pid: number | null;
  workerId?: string | null;
  /** When the session's stream closed. `null` for a session the board still believes is running. */
  endedAt?: string | null;
}

/**
 * How long after a session's recorded end its pid is still believed to name that session.
 *
 * **A pid is not a durable identifier, and `sessions.pid` is never cleared.** Every other pid
 * consumer in this codebase (`cleanupStaleSessions`, the zombie reconciler) reads it only for
 * rows with `status === "running"` for exactly that reason. This guard deliberately cannot do
 * that — the #968 session was `completed`, which is the status a status filter would most
 * obviously skip — so it needs the other bound.
 *
 * Without one, a workspace whose session ended weeks ago holds a pid the OS has long since
 * recycled onto an unrelated process. `isPidAlive` says yes, the guard says `live`, and
 * `launchSession` refuses **forever** — including the monitor's auto-relaunch, which passes no
 * `force`, so a hands-off project would strand the workspace with no way out but a hand edit.
 * That is a strictly worse failure than the one this guard prevents: #968 was rare, recoverable
 * and noticed by both agents, whereas this would be permanent and silent.
 *
 * An hour is far longer than any real gap between a stream closing and its survivors exiting
 * (#968's zombie was found ~16 minutes after its recorded end) and far shorter than the horizon
 * over which pid recycling becomes likely. A row with NO `endedAt` — the board still thinks it
 * is running — is always probed: it has no recorded end to be stale relative to.
 */
export const SURVIVOR_PROBE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Is this row's pid still trustworthy as a name for this session?
 *
 * Pure and exported so the window is testable without a process table — the recency rule is
 * the part that decides whether a guard becomes a permanent block.
 */
export function pidStillIdentifiesSession(row: SessionPidRow, nowMs: number = Date.now()): boolean {
  if (!row.endedAt) return true;
  const endedMs = Date.parse(row.endedAt);
  // An unparseable timestamp is not evidence that the row is stale; probe it, as before.
  if (!Number.isFinite(endedMs)) return true;
  return nowMs - endedMs <= SURVIVOR_PROBE_WINDOW_MS;
}

/**
 * Probe every host-pid session of a workspace and report whether any agent process tree is
 * still alive.
 *
 * Two injection seams, because there are two things worth testing separately: `probeTree`
 * replaces the whole per-session verdict (the aggregation logic under fixed answers), while
 * `enumerate` replaces only the process-table read and keeps the REAL probe plus the shared
 * snapshot below — which is the only way to assert that the table is read once per workspace
 * rather than once per session.
 */
export async function findLiveAgentTrees(
  sessionRows: SessionPidRow[],
  opts: {
    /** Override the whole per-session verdict. Bypasses the shared snapshot below. */
    probeTree?: (pid: number | null | undefined) => Promise<TreeLiveness> | TreeLiveness;
    /** Override only the process-table read, keeping the real probe and the sharing seam. */
    enumerate?: () => Promise<ProcessTableRow[] | null> | ProcessTableRow[] | null;
    checkPid?: (pid: number) => boolean;
    /** Injected clock for the recency window. See {@link pidStillIdentifiesSession}. */
    nowMs?: number;
  } = {},
): Promise<WorkspaceAgentLiveness> {
  // ONE process-table snapshot for the whole workspace, not one per session. Each probe would
  // otherwise spawn its own enumeration, so a workspace with five prior sessions would pay
  // five PowerShell spawns on every relaunch — and the five snapshots could disagree, which
  // is worse than the cost. A snapshot taken once is also the more honest reading: it answers
  // "what was running at this instant" rather than a smear across several instants.
  const readTable = opts.enumerate ?? enumerateProcesses;
  let snapshot: Promise<ProcessTableRow[] | null> | null = null;
  const sharedEnumerate = (): Promise<ProcessTableRow[] | null> => {
    // Memoize the PROMISE, not its result, so concurrent probes join the one read in flight
    // instead of each starting their own.
    snapshot ??= Promise.resolve().then(readTable).catch(() => null);
    return snapshot;
  };
  const probeTree = opts.probeTree ?? ((pid: number | null | undefined) =>
    probeProcessTree(pid, { enumerate: sharedEnumerate, checkPid: opts.checkPid }));

  const trees: LiveAgentTree[] = [];
  let sawUnknown = false;
  let probed = 0;

  for (const row of sessionRows) {
    // No host pid: either a remote session (the worker's question, not ours) or a row that
    // never got as far as a spawn. Neither is evidence of a live local process.
    if (!row.pid) continue;
    // A pid the OS may already have handed to someone else names nothing. Skipping is not a
    // weakening of the guard: the survivor it exists to catch is by definition recent, and a
    // stale pid answering `alive` would block every relaunch of this workspace permanently.
    if (!pidStillIdentifiesSession(row, opts.nowMs)) continue;
    probed++;
    let verdict: TreeLiveness;
    try {
      verdict = await probeTree(row.pid);
    } catch {
      sawUnknown = true;
      continue;
    }
    if (verdict.liveness === "unknown") {
      sawUnknown = true;
      continue;
    }
    if (verdict.liveness === "alive") {
      trees.push({ sessionId: row.id, pid: row.pid, pids: verdict.pids, reason: verdict.reason });
    }
  }

  // A found tree outranks an unreadable one: we already know enough to refuse, and reporting
  // `unknown` would drop the concrete evidence we hold.
  if (trees.length > 0) {
    return {
      verdict: "live",
      trees,
      reason: trees
        .map((t) => `session ${t.sessionId} (${t.reason})`)
        .join("; "),
    };
  }
  if (sawUnknown) {
    return { verdict: "unknown", trees: [], reason: "the process table could not be read for one or more sessions" };
  }
  return {
    verdict: "clear",
    trees: [],
    reason: probed === 0
      ? "no prior session of this workspace holds a host pid"
      : `all ${probed} prior host session(s) have fully exited`,
  };
}

/**
 * The refusal message a blocked relaunch carries.
 *
 * Written to be acted on rather than merely obeyed: it names the surviving pids, says why the
 * board is refusing rather than what it refused, and names the override. A guard whose message
 * does not tell the caller how to proceed is one that gets routed around.
 */
export function liveAgentRefusalMessage(liveness: WorkspaceAgentLiveness): string {
  const pids = [...new Set(liveness.trees.flatMap((t) => t.pids))].join(", ");
  return (
    `Refusing to launch: an agent process tree from a previous session of this workspace is still alive ` +
    `(${liveness.reason}). Launching now would put two agents in one worktree on one branch, which is how ` +
    `#968 happened — the previous session was recorded 'completed' with exit 0 while its process kept editing ` +
    `files. Wait for it to exit, or stop it (pids: ${pids || "unknown"}), then retry. ` +
    `Pass force: true to launch anyway.`
  );
}
