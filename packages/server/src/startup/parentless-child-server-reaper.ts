import { listOsProcesses, killProcessTree } from "../services/process-exec.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * Command-line markers of board-spawned child web servers that are safe to reap
 * once their parent is gone. Deliberately narrow: each is a short-lived static
 * file/preview server the board starts on behalf of a plugin view or a review
 * artifact, never a long-lived service and never an agent process.
 *
 * NOT in this list, on purpose: `scripts/dev.mjs` (a supervisor another agent's
 * worktree may legitimately own), any `tsx`/backend process, and anything
 * agent-related. Killing a dev supervisor is the documented never-do.
 */
const REAPABLE_CHILD_SERVER_MARKERS = [
  "serve.mjs",
  "review-server.mjs",
  "ui-map-serve.mjs",
];

/**
 * Sweep board-spawned child servers whose parent process no longer exists (#281).
 *
 * Complements `reapOrphanedPluginViewProcesses`, which can only reap what the DB
 * remembers. Observed on this dev box: **85** `serve.mjs`-family processes with a
 * dead parent, the oldest 4 days old — spawned by server generations that predate
 * PID persistence, or by tests that spawn a `serve.mjs` out of a temp
 * `plugin-test-plugin-<id>` directory and never reap them. They accumulate
 * indefinitely because nothing owns them.
 *
 * Two conditions must BOTH hold before killing, which is what makes this safe to
 * run unattended:
 *  1. the command line matches `REAPABLE_CHILD_SERVER_MARKERS`, and
 *  2. the parent PID is not among the live processes — i.e. it is a true orphan,
 *     so no supervisor is going to miss it.
 *
 * A process whose parent is alive is left strictly alone: that is someone's
 * running plugin view, possibly in another worktree.
 *
 * Its own module (#1223) — `startup-tasks.ts` sits at the god-module gate's 1000-line
 * ceiling, and this sweep is self-contained (no shared state with anything else in that file).
 */
export async function reapParentlessChildServers(): Promise<number> {
  let osProcs: Awaited<ReturnType<typeof listOsProcesses>>;
  try {
    osProcs = await listOsProcesses();
  } catch (err) {
    console.warn("[startup] could not enumerate processes for orphan sweep (non-fatal):", errorMessage(err));
    return 0;
  }

  const livePids = new Set(osProcs.map((p) => p.pid));
  const orphans = osProcs.filter((proc) => {
    if (proc.pid === process.pid) return false;
    const cmd = proc.commandLine || "";
    if (!REAPABLE_CHILD_SERVER_MARKERS.some((marker) => cmd.includes(marker))) return false;
    // ppid 0 means "unknown" from the enumerator, not "orphan" — don't guess.
    if (!proc.ppid) return false;
    return !livePids.has(proc.ppid);
  });

  if (orphans.length === 0) return 0;

  let killed = 0;
  for (const orphan of orphans) {
    try {
      await killProcessTree(orphan.pid);
      killed++;
    } catch (err) {
      console.warn(`[startup] failed to reap parentless child server PID ${orphan.pid} (non-fatal):`, errorMessage(err));
    }
  }
  console.log(`[startup] reaped ${killed}/${orphans.length} parentless child server process(es)`);
  return killed;
}
