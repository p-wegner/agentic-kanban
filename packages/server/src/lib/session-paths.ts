import { tmpdir } from "node:os";
import { join } from "node:path";

// Pure, stateless path builders for a detached session's capture files. These live in a
// leaf lib module (not agent.service) so the persistence layer can compute the same paths
// without a repository -> service import inversion (enforced by lint:arch's
// repositories-not-up-to-services rule).

/** Get the stdout output file path for a session. */
export function sessionOutputPath(sessionId: string): string {
  return join(tmpdir(), `kanban-session-${sessionId}.out`);
}

/**
 * Get the stderr capture file path for a detached session.
 *
 * Detached agents (claude on Windows — see {@link launchAgent}) redirect stdout to the
 * `.out` file, but stderr used to be discarded (`stdio[2] = "ignore"`). When the provider
 * process dies BEFORE emitting any stdout (e.g. claude.exe exits 1 immediately from a
 * fix-and-merge launch in a mid-rebase / conflicted worktree), the `.out` file is 0 bytes
 * and the only diagnostic — the reason on stderr — was thrown away, producing an invisible
 * "0-token zombie" (#779). We now redirect stderr to this file so the failure is debuggable.
 */
export function sessionErrorPath(sessionId: string): string {
  return join(tmpdir(), `kanban-session-${sessionId}.err`);
}
