/**
 * Asking the board for a fresh git token after a 401 (#1383).
 *
 * A leaf of `worker-agent-runner.ts`: it holds only the table of in-flight requests, and takes
 * the runner's non-throwing `send` as its one collaborator. Resolves `null` when the board has
 * none to give or does not answer in time (an older board drops the request as unknown).
 */
import type { WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";

/** How long a result push waits for the board to issue a fresh git token. */
export const GIT_TOKEN_WAIT_MS = 15_000;

export function createGitTokenRequester(send: (message: WorkerToBoardMessage) => void, waitMs = GIT_TOKEN_WAIT_MS) {
  const waiters = new Map<string, (token: string | null) => void>();
  let seq = 0;

  function request(sessionId: string): Promise<string | null> {
    return new Promise((resolve) => {
      const requestId = `token-${sessionId}-${++seq}`;
      const settle = (token: string | null): void => {
        clearTimeout(timer);
        waiters.delete(requestId);
        resolve(token);
      };
      const timer = setTimeout(() => settle(null), waitMs);
      if (timer.unref) timer.unref();
      waiters.set(requestId, settle);
      send({ type: "git_token_request", sessionId, requestId });
    });
  }

  /** The board's `git_token` answer. An unknown or already-timed-out request is dropped. */
  function answer(requestId: string, token: string | null): void {
    waiters.get(requestId)?.(token);
  }

  return { request, answer };
}

/**
 * #1383: turn a failed git fetch/push message into one that names the HTTP status when git
 * reported one (`The requested URL returned error: 401`, `HTTP 403`, ...) and keeps only the
 * last lines of stderr, so a worker log line says WHY the transport failed.
 */
export function describeGitTransportFailure(message: string): string {
  const tail = message.trim().split(/\r?\n/).slice(-6).join(" | ").slice(-600);
  const status = /returned error: (\d{3})|HTTP (?:code )?(\d{3})|(40[13]).*(?:unauthorized|forbidden)/i.exec(message);
  const code = status ? (status[1] ?? status[2] ?? status[3]) : undefined;
  if (code === "401") return `HTTP 401 (board rejected the git token: unknown, expired or revoked): ${tail}`;
  if (code === "403") return `HTTP 403 (board refused this assignment/ref): ${tail}`;
  if (/terminal prompts disabled|could not read Username|Authentication failed/i.test(message)) {
    return `authentication failed (git was not allowed to prompt): ${tail}`;
  }
  return code ? `HTTP ${code}: ${tail}` : tail;
}
