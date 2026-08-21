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

/** Compact slash-command descriptor surfaced to the UI autocomplete. */
export interface ButlerCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

/** One question of an AskUserQuestion call, normalised for the chat UI. */
export interface ButlerQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: ButlerQuestionOption[];
}

/** The user's answer to one question (one entry for single-select, N for multi). */
export interface ButlerQuestionAnswer {
  question: string;
  header: string;
  answers: string[];
}

/** One selectable choice of an AskUserQuestion question. */
export interface ButlerQuestionOption {
  label: string;
  description?: string;
}

export interface ButlerSessionMessage {
  role: "user" | "assistant";
  text: string;
  ts: number;
}

export interface ButlerSessionSummary {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  title: string;
  turnCount: number;
  model?: string;
}
