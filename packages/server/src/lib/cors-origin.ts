/**
 * CORS origin allowlist for the local REST API.
 *
 * The board is a single-user, local-first app with NO API auth (any process on
 * the box has full board authority — by design). The one trust edge a remote
 * attacker can actually reach is the user's own BROWSER: a wildcard
 * `Access-Control-Allow-Origin: *` let any website the user visits issue
 * cross-origin requests to `localhost:3001` and READ the responses
 * (confused-deputy — list/delete issues, merge, register projects, reach the
 * codemod-apply / LLM-shell paths). This allowlist closes that edge.
 *
 * What legitimately needs cross-origin access:
 *  - the Vite dev client (`localhost`/`127.0.0.1`:5173, and worktree variants on
 *    other localhost ports),
 *  - the Tauri desktop webview (`tauri://localhost`, `https://tauri.localhost`).
 * Remote/Tailscale access serves the client from the server's OWN origin
 * (same-origin → no CORS involved), so it needs no entry here.
 *
 * Non-browser clients (curl, the CLI, server-to-server) send no `Origin` header
 * and ignore CORS entirely, so tightening this never affects them.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const TAURI_ORIGINS = new Set([
  "tauri://localhost",
  "https://tauri.localhost",
  "http://tauri.localhost",
]);

/** True if `origin` is a trusted local UI origin we may reflect in `Access-Control-Allow-Origin`. */
export function isAllowedCorsOrigin(origin: string | undefined | null): boolean {
  if (!origin) return false;
  if (TAURI_ORIGINS.has(origin)) return true;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  // URL.hostname yields "[::1]" for the bracketed IPv6 form and "::1" is never
  // produced, but accept both spellings defensively.
  return LOOPBACK_HOSTS.has(host);
}

/**
 * `origin` callback for Hono's `cors()`. Echoes the request origin only when it
 * is a trusted local UI origin (so the response carries the specific origin, not
 * `*`); returns `null` to omit the header entirely for everything else, which
 * makes the browser block the cross-origin read.
 */
export function corsOrigin(origin: string): string | null {
  return isAllowedCorsOrigin(origin) ? origin : null;
}
