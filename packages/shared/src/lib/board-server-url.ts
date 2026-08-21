const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 3001;
const DEFAULT_CLIENT_PORT = 5173;

/**
 * THE board-server port ladder (#615). `KANBAN_SERVER_PORT || PORT || "3001"` was copied
 * ten times across routes, services and startup while this helper already existed — a
 * helper landed, the ring not drained — so a new rung (`KANBAN_BOARD_SERVER_PORT`, which is
 * how a worktree names the MAIN board) reached some callers and not others.
 *
 * `env` is injectable so a caller that already takes an env — a pure port resolver, a
 * launch-env builder — can use the one ladder without reaching for `process.env` and
 * losing its testability.
 */
export function resolveBoardServerPort(
  override?: string | number,
  env: Record<string, string | undefined> = process.env,
): number {
  if (override !== undefined) {
    const parsed = Number(override);
    if (parsed) return parsed;
  }
  return (
    Number(env.KANBAN_BOARD_SERVER_PORT) ||
    Number(env.KANBAN_SERVER_PORT) ||
    Number(env.SERVER_PORT) ||
    Number(env.PORT) ||
    DEFAULT_PORT
  );
}

/**
 * THE board-client port ladder — the client-side twin of `resolveBoardServerPort` (#690).
 * `KANBAN_CLIENT_PORT || VITE_PORT || "5173"` was copied verbatim into three services
 * (agent launch env, review-agent prompt, the post-merge verify-agent prompt) with no
 * shared resolver, so a rung added to one copy would silently miss the others.
 */
export function resolveBoardClientPort(
  override?: string | number,
  env: Record<string, string | undefined> = process.env,
): number {
  if (override !== undefined) {
    const parsed = Number(override);
    if (parsed) return parsed;
  }
  return Number(env.KANBAN_CLIENT_PORT) || Number(env.VITE_PORT) || DEFAULT_CLIENT_PORT;
}

export function boardApiUrl(path: string, port?: string | number): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `http://${LOOPBACK_HOST}:${resolveBoardServerPort(port)}${normalizedPath}`;
}

export async function boardApi(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; statusText: string; data: unknown }> {
  const res = await fetch(boardApiUrl(path), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error body */
  }
  // `statusText` is carried (#508) because the hand-rolled `fetch` blocks this replaces
  // fall back to it when the error body has no `error` field — "Not Found" rather than
  // a bare 404. Dropping it would have quietly degraded every one of those messages.
  return { ok: res.ok, status: res.status, statusText: res.statusText, data };
}
