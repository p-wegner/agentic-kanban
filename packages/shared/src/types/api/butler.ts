// Butler wire-contract types (pure DTOs). See ../api.ts barrel.

/**
 * `POST /api/projects/:id/butler/ask` — the synchronous ask used by the CLI and the
 * `ask_butler` MCP tool.
 *
 * #571: this interface was declared twice, byte-identically and independently, in
 * `cli/commands/butler.ts` and `mcp-server/src/tools/ask-butler.ts`. Two hand-written
 * copies of one endpoint's shape drift silently — the same class of bug that made the CLI
 * print `Stats: [object Object]` for the diff endpoint and never print a scorecard's score.
 */
export interface ButlerAskResponse {
  sessionId: string | null;
  text: string;
  isError: boolean;
  error?: string;
}
