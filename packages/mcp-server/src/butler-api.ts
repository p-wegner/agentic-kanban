/**
 * The butler tools' board-API call, once (#508).
 *
 * Ten butler tools (`ensure`, `stop`, `interrupt`, `list`, `set-model`, `set-profile`,
 * `skill` x2, `state`, `ask`) each carried the same block: `fetch(boardApiUrl(...))`,
 * `await res.json()`, `if (!res.ok)` with a per-tool label, and a catch emitting
 * "Failed to reach the butler (is the server running on port N?)". The only real
 * variation is the LABEL and whether the success payload is pretty-printed.
 *
 * Note this does NOT add a new `boardApi` — one already exists in
 * `shared/lib/board-server-url.ts` returning `{ ok, status, statusText, data }`, and had
 * been adopted by exactly two files. The work here is adoption, not creation. (The
 * ticket proposed writing a fresh `mcp-server/src/board-api.ts`; that would have been a
 * second copy of the thing it was trying to deduplicate.)
 */
import { boardApi } from "@agentic-kanban/shared/lib/board-server-url";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { getServerPort } from "./server-url.js";

type McpTextResult = { content: Array<{ type: "text"; text: string }> };

/** The MCP text envelope, built once instead of at 232 literal sites. */
export function mcpText(text: string): McpTextResult {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Pull the server's error message out of a JSON error body, falling back to the HTTP
 * status text.
 *
 * The array check is not defensive noise: `butler_list` returns a JSON ARRAY on success,
 * and its hand-written version had to guard against reading `.error` off one. Keeping the
 * guard here means every tool gets it rather than the one that happened to need it.
 */
function errorTextFrom(data: unknown, statusText: string): string {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const err = (data as { error?: unknown }).error;
    if (typeof err === "string" && err) return err;
  }
  return statusText;
}

/**
 * Call a butler endpoint and render the MCP result.
 *
 * `label` is the tool's own prefix ("Butler ensure", "Butler stop", …) so the failure
 * text a caller sees is unchanged. `pretty` reproduces the two-space `JSON.stringify`
 * that `butler_list`, `butler_state` and the skill tools use — the others emit compact
 * JSON, and unifying that would change output every consumer already parses.
 *
 * `render` exists for `ask_butler`, whose success payload is the reply TEXT rather than
 * the JSON envelope. Without it the helper would have had to either exclude that tool
 * (leaving the fork it was meant to remove) or change what the butler answers with.
 */
export async function butlerCall(
  label: string,
  path: string,
  init?: RequestInit,
  opts?: { pretty?: boolean; render?: (data: unknown) => string },
): Promise<McpTextResult> {
  try {
    const { ok, statusText, data } = await boardApi(path, init);
    if (!ok) return mcpText(`${label} error: ${errorTextFrom(data, statusText)}`);
    if (opts?.render) return mcpText(opts.render(data));
    return mcpText(JSON.stringify(data, null, opts?.pretty ? 2 : undefined));
  } catch (err) {
    return mcpText(
      `Failed to reach the butler (is the server running on port ${getServerPort()}?): ${errorMessage(err)}`,
    );
  }
}

/** `?butler=<id>` for a non-default butler, else empty — repeated in six of the tools. */
export function butlerQuery(butler?: string): string {
  return butler && butler !== "default" ? `?butler=${encodeURIComponent(butler)}` : "";
}
