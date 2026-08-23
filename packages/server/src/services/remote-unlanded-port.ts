/**
 * Where the board's hot per-card paths get at this process's remote-session map (#790).
 *
 * Its own module for one reason: `worker-remote-sync.service.ts` documents that it must not
 * reference the remote agent service — statically OR as a type, since dependency-cruiser
 * counts both — because either closes a cycle. So its `unlandedRemoteBranches` helper takes a
 * structural port, and SOMETHING has to supply it. Two callers need that something
 * (`board-status.ts` and `workspace-summary.service.ts`), and a copy in each is how the next
 * reader ends up with a subtly different fallback.
 */
import { getWorkerFleet } from "./worker-fleet.service.js";
import type { Database } from "../db/index.js";
import type { RemoteUnlandedPort } from "./worker-remote-sync.service.js";

/**
 * The port, or null when this process has no fleet wired in.
 *
 * The cast is the one `routes/workspace-actions.ts` already makes: the fleet facade types its
 * member as the narrow `AgentExecutionService` while the remote implementation is a documented
 * superset. Null is a normal answer, not an error — a board with no fleet simply has no remote
 * work to warn about, and the card falls back to exactly the pre-#790 rendering.
 */
export function resolveRemoteUnlandedPort(database: Database): RemoteUnlandedPort | null {
  try {
    const ops = getWorkerFleet(database).remoteAgentService as unknown as RemoteUnlandedPort;
    return typeof ops.remoteGitTransportSessions === "function" ? ops : null;
  } catch {
    return null;
  }
}
