/**
 * The MCP tools' board-API call and error-text rule, once (#508).
 *
 * ~20 tools each opened `fetch(boardApiUrl(...))` with their own `res.json()`,
 * `if (!res.ok)`, `data.error ?? res.statusText` and unreachable-catch. The drift that
 * mattered was in the error path: some tools fell back to `statusText`, some to a bare
 * status, some swallowed a non-JSON body and reported nothing at all.
 *
 * The CALL itself is `boardApi` from `shared/lib/board-server-url` — already the seam, and
 * writing a second one in this package is what the ticket accidentally proposed. The
 * ENVELOPE is `mcpText`/`mcpJson` in `db-utils.ts`, which #617 already unified; defining
 * a second pair here would have re-split it, so they are re-exported, not redeclared.
 *
 * What is genuinely new here: the error-text rule, the unreachable message, and the
 * text-body call variant for endpoints that answer markdown rather than JSON.
 */
import { boardApi, boardApiUrl } from "@agentic-kanban/shared/lib/board-server-url";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { mcpText, type McpResponse } from "./db-utils.js";
import { getServerPort } from "./server-url.js";

export { mcpText, mcpJson } from "./db-utils.js";
export type { McpResponse } from "./db-utils.js";

/**
 * The server's error message, falling back to the HTTP status text.
 *
 * The array guard is not defensive noise: several endpoints answer with a JSON ARRAY, and
 * reading `.error` off one is how a tool ends up reporting `undefined` as its error.
 */
export function boardErrorText(data: unknown, statusText: string): string {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const err = (data as { error?: unknown }).error;
    if (typeof err === "string" && err) return err;
  }
  return statusText;
}

/** The unreachable-board message, naming the port so the caller can check the right one. */
export function mcpUnreachable(err: unknown, what = "the board server"): McpResponse {
  return mcpText(`Failed to reach ${what} (is it running on port ${getServerPort()}?): ${errorMessage(err)}`);
}

/**
 * `boardApi` for endpoints whose body is TEXT, not JSON (backlog markdown, the handoff
 * bundle, the merge result). Parsing those as JSON is what forced those tools to keep a
 * raw `fetch`.
 */
export async function boardApiText(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; statusText: string; text: string }> {
  const res = await fetch(boardApiUrl(path), init);
  const text = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, statusText: res.statusText, text };
}

export { boardApi };
