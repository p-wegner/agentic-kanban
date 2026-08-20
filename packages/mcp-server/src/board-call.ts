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
    const rec = data as { error?: unknown; detail?: unknown };
    const err = typeof rec.error === "string" && rec.error ? rec.error : null;
    // #684 — `detail` is the other half of the server's error contract: the
    // `AiOperationError` branch of `middleware/error-handler.ts` puts the raw AI response
    // there, i.e. the one field that says WHY a prediction failed. Reading only `error`
    // dropped it, so what reached the agent was the generic sentence and nothing actionable.
    const detail = typeof rec.detail === "string" && rec.detail ? rec.detail : null;
    if (err && detail) return `${err} — ${detail}`;
    if (err) return err;
    if (detail) return detail;
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
): Promise<{ ok: boolean; status: number; statusText: string; text: string; bodyError?: string }> {
  const res = await fetch(boardApiUrl(path), init);
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    // #684 — this read used to be `.catch(() => "")`, which turned a truncated or aborted
    // body into an EMPTY STRING while leaving `ok` true. For `merge_workspace` that is the
    // worst possible shape: the tool returns `mcpText("")`, so an empty SUCCESSFUL merge is
    // reported, and every agent that treats a non-error response as "merged" — Conductor,
    // monitor, butler — is misled about whether the branch landed. Before the #508
    // consolidation the read sat outside the try/catch and surfaced as an MCP error.
    //
    // A response whose body could not be read is not a success, whatever the status line
    // said, so `ok` is false here and the reason rides on `statusText` (which every caller
    // already renders) as well as on `bodyError` for callers that want to branch on it.
    const reason = errorMessage(err);
    return {
      ok: false,
      status: res.status,
      statusText: `${res.statusText || `HTTP ${res.status}`} (response body could not be read: ${reason})`,
      text: "",
      bodyError: reason,
    };
  }
  return { ok: res.ok, status: res.status, statusText: res.statusText, text };
}

export { boardApi };
