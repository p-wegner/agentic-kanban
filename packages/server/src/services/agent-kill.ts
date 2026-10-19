import { execErrorMessage, execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import { dockerExec } from "@agentic-kanban/shared/lib/docker-exec";
import { guardProcessKill } from "./process-guard.js";
import { killProcessTree } from "./process-exec.js";

/**
 * Stop one agent session's process, through the ONE kill seam (#833).
 *
 * It used to branch on `process.platform` here: `taskkill /T /F` on Windows, a bare
 * `process.kill(pid, "SIGTERM")` on POSIX. Both halves were wrong for the same reason
 * #828 exposed. Since #828 every provider ORs `commandCarriesArgs(command)` into
 * `useShell`, so on POSIX an agent launched from an explicit command line
 * (`agentCommand` / `KANBAN_AGENT_COMMAND`, every mock-agent command) is spawned as
 * `sh -c "<command>"` — and `shouldDetachAgent` detaches it, so `pid` is the SHELL's,
 * and that shell leads its own process group. A simple command is `exec`ed through, so
 * the pid usually is the agent; a pipeline, an `&&`, or a trailing redirect leaves `sh`
 * a genuine parent, and then SIGTERM to the bare pid killed the shell and left the agent
 * running while the board recorded the session as stopped.
 *
 * `group: true` signals the process group instead, which reaches the shell and every
 * child it forked; the seam falls back to the bare pid when there is no group. SIGTERM
 * is passed explicitly — the seam's default is SIGKILL, and a stopped agent is asked to
 * shut down, not shot. Windows is unchanged in reach (`taskkill /T /F` was and is a tree
 * kill); it merely moved onto the mockable seam so the platform decision lives in ONE
 * place and the tests are platform-identical.
 *
 * Fire-and-forget: `kill()`/`killAll()` are synchronous, and a kill failure has never
 * been fatal here.
 */
export function killPid(pid: number, context: Record<string, unknown>): boolean {
  if (!guardProcessKill(pid, context)) return false;
  void killProcessTree(pid, { timeout: 5000, signal: "SIGTERM", group: true }).catch((err) => {
    if ((err as NodeJS.ErrnoException)?.code === "ESRCH") return; // already gone
    console.warn(`[agent] failed to kill pid=${pid}`, err);
  });
  return true;
}

/**
 * Terminate the agent running INSIDE a container (#154).
 *
 * The host-side `killPid()` above only reaches the `docker exec` CLIENT — the
 * exec'd agent process lives in the container's own PID namespace and is not
 * in that process tree, so killing the client orphans it: invisible (output
 * conduit severed, board says "stopped"), still able to edit the bind-mounted
 * worktree while review/merge proceeds. `docker kill` sends SIGKILL to the
 * container's PID 1, which tears down every process in its namespace,
 * including the exec'd one — a single call that doesn't require tracking the
 * inner PID. Fire-and-forget: the docker CLI is a real executable so this
 * never blocks the synchronous `kill()`/`killAll()` callers, and a failure
 * here is logged, never thrown (matches the rest of the devcontainer
 * best-effort contract).
 */
export function killContainerAgent(sessionId: string, containerId: string): void {
  console.log(`[agent] killing containerized agent: sessionId=${sessionId} containerId=${containerId.slice(0, 12)}`);
  void dockerExec(["kill", containerId]).then((result) => {
    if (!execSucceeded(result)) {
      console.warn(
        `[agent] docker kill failed: sessionId=${sessionId} containerId=${containerId.slice(0, 12)}: ${execErrorMessage(result)}`,
      );
    }
  });
}
