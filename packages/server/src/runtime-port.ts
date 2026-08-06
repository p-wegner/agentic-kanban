const DEFAULT_SERVER_PORT = 3001;

function parsePort(value: string | undefined): number | null {
  if (!value) return null;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : null;
}

export function resolveRuntimeServerPort(env: NodeJS.ProcessEnv = process.env): number {
  return (
    parsePort(env.KANBAN_INTERNAL_SERVER_PORT) ??
    parsePort(env.KANBAN_WORKTREE_SERVER_PORT) ??
    parsePort(env.KANBAN_SERVER_PORT) ??
    parsePort(env.SERVER_PORT) ??
    parsePort(env.PORT) ??
    DEFAULT_SERVER_PORT
  );
}

/**
 * The externally REACHABLE base URL of the board's API — what a CLIENT (a plugin view server,
 * a script, a loop planner, a browser) should call.
 *
 * Deliberately NOT `resolveRuntimeServerPort`: in dev the backend BINDS the internal port
 * (`KANBAN_INTERNAL_SERVER_PORT`, e.g. 13001) behind the stable dev proxy which owns the public
 * port (e.g. 3001) — see `scripts/server-dev-proxy.mjs`. A URL naming the internal port dies on
 * every tsx-watch restart and is wrong for anything the proxy fronts, so the port chain here
 * mirrors the proxy's own `resolvePublicServerPort` (worktree → KANBAN_SERVER_PORT → SERVER_PORT
 * → PORT → 3001) and skips the internal port entirely. A worktree server on 3001+N therefore
 * produces its own URL. Host is `localhost` — same convention as every other client-facing URL
 * the board hands out (view URLs, the butler's `{{serverPort}}` API line).
 */
export function resolvePublicBoardUrl(env: NodeJS.ProcessEnv = process.env): string {
  const port =
    parsePort(env.KANBAN_WORKTREE_SERVER_PORT) ??
    parsePort(env.KANBAN_SERVER_PORT) ??
    parsePort(env.SERVER_PORT) ??
    parsePort(env.PORT) ??
    DEFAULT_SERVER_PORT;
  return `http://localhost:${port}`;
}
