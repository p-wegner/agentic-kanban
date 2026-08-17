/**
 * Classifier for transient network errors that should not crash the dev server.
 *
 * The warm butler Claude Agent SDK session keeps an HTTPS connection open to the
 * Anthropic API. When `tsx watch` restarts the process on file change (or a merge
 * tears down a worktree), the socket gets killed mid-read and Node surfaces
 * `Error: read ECONNRESET` from `TCP.onStreamRead`. With no upstream listener,
 * this bubbles to `uncaughtException` and historically killed the dev loop
 * (see `scripts/dev-supervisor.mjs` — code=1 is fatal, no auto-restart).
 *
 * We treat these as warnings instead of crashes. This is defense-in-depth: the
 * butler-sdk service has its own try/catch around the SDK iterator, but a future
 * network-using service could regress, so the top-level handler also filters.
 */

const TRANSIENT_CODES = new Set([
  // Network errors (butler/Anthropic HTTPS socket torn down during tsx hot-reload)
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ECONNABORTED",
  // Filesystem lock errors (Windows: git worktree remove on a busy directory)
  "EBUSY", "ENOTEMPTY",
]);

export function isTransientNetworkError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  // Fallback: some errors arrive as plain Error with the code in the message.
  if (err instanceof Error && /ECONNRESET|ECONNREFUSED|EPIPE|EBUSY|ENOTEMPTY/.test(err.message)) return true;
  return false;
}
