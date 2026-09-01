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
