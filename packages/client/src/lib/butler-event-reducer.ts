// Pure state machine for the Butler SSE event stream.
//
// Extracted from ButlerView's imperative handleButlerEvent so the reduction is
// independently unit-testable (repo convention: extract pure logic, test it —
// cf. lib/checklist.ts, hooks/ticketTrailCore.ts). ButlerView keeps the per-tab
// assistant-text buffer in a ref and threads it through reduceButlerEvent; the
// reducer never touches the DOM, Date.now, or Math.random (both injected via
// deps) so it can be exercised deterministically.

/** One selectable choice of an AskUserQuestion question. */
export interface ButlerQuestionOption {
  label: string;
  description?: string;
}

/** One question of an AskUserQuestion call (server: normalizeButlerQuestions). */
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

/** A question card in the chat: pending (answerable) or resolved (read-only). */
export interface ButlerQuestionPrompt {
  askId: string;
  questions: ButlerQuestion[];
  /** Set once the question is over. `answers` is absent for a denial. */
  resolved?: { answers?: ButlerQuestionAnswer[]; reason?: string };
}

/** Event shape emitted by the server butler SSE stream (butler-sdk.service.ts). */
export type ButlerEvent =
  | { type: "ready" }
  | { type: "session"; sessionId: string }
  | { type: "turn-start" }
  | { type: "user"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; toolId?: string; input?: Record<string, unknown> }
  | { type: "tool-result"; toolId?: string; output?: string; isError?: boolean }
  | { type: "result"; text?: string; isError?: boolean }
  | { type: "usage"; contextTokens: number }
  | { type: "meta"; model?: string; contextWindow?: number; mcpConnected?: boolean }
  | { type: "question"; askId: string; questions: ButlerQuestion[] }
  | { type: "question-resolved"; askId: string; answers?: ButlerQuestionAnswer[]; reason?: string }
  | { type: "error"; message: string };

export interface ButlerToolCall {
  name: string;
  input?: Record<string, unknown>;
  output?: string;
  status: "pending" | "done" | "error";
}

export interface ButlerChatMessage {
  id: string;
  role: "user" | "assistant" | "activity" | "tool" | "question";
  text: string;
  ts: number;
  tool?: ButlerToolCall;
  question?: ButlerQuestionPrompt;
}

/** Accumulator for streamed assistant text within a single turn. */
export interface AssistantBuf {
  buf: string;
  msgId: string | null;
  textSeen: boolean;
}

export function emptyAssistantBuf(): AssistantBuf {
  return { buf: "", msgId: null, textSeen: false };
}

/**
 * The slice of a tab's state the reducer reads and writes. ButlerView's TabState
 * is a structural supertype, so reduceButlerEvent preserves its full type.
 */
export interface ButlerChatState {
  chatMessages: ButlerChatMessage[];
  butlerState: { active: boolean; sessionId: string | null } | null;
  contextTokens: number;
  model: string | undefined;
  contextWindow: number | undefined;
  mcpConnected: boolean | undefined;
  sending: boolean;
}

/** Injected, so ids/timestamps are deterministic under test. */
export interface ReducerDeps {
  now: () => number;
  rand: () => string;
}

/** Human-readable label for a tool-call card. */
export function formatToolLabel(name: string): string {
  if (name === "Read") return "Reading a file";
  if (name === "Write" || name === "Edit") return "Editing a file";
  if (name === "Bash") return "Running a command";
  if (name === "Glob" || name === "Grep") return "Searching the project";
  if (name === "WebSearch" || name === "WebFetch") return "Searching the web";
  if (name.includes("list_issues")) return "Listing board issues";
  if (name.includes("get_board_status")) return "Checking board status";
  return name.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
}

function appendAssistantText<S extends ButlerChatState>(
  state: S,
  buf: AssistantBuf,
  delta: string,
  deps: ReducerDeps,
): { state: S; buf: AssistantBuf } {
  if (!delta) return { state, buf };
  const text = buf.buf + delta;
  const msgId = buf.msgId ?? `asst-${deps.now()}-${deps.rand()}`;
  const nextBuf: AssistantBuf = { buf: text, msgId, textSeen: true };
  const msgs = state.chatMessages;
  const last = msgs[msgs.length - 1];
  const newMsgs: ButlerChatMessage[] = last && last.id === msgId
    ? [...msgs.slice(0, -1), { ...last, text }]
    : [...msgs, { id: msgId, role: "assistant", text, ts: deps.now() }];
  return { state: { ...state, chatMessages: newMsgs }, buf: nextBuf };
}

function settlePendingTools<S extends ButlerChatState>(state: S): S {
  if (!state.chatMessages.some((m) => m.role === "tool" && m.tool?.status === "pending")) return state;
  return {
    ...state,
    chatMessages: state.chatMessages.map((m) =>
      m.role === "tool" && m.tool?.status === "pending"
        ? { ...m, tool: { ...m.tool, status: "done" as const } }
        : m,
    ),
  };
}

/**
 * Apply one SSE event to a tab's chat state + assistant buffer, returning fresh
 * copies (never mutates the inputs). Behaviour is a faithful port of the original
 * handleButlerEvent switch.
 */
export function reduceButlerEvent<S extends ButlerChatState>(
  state: S,
  buf: AssistantBuf,
  event: ButlerEvent,
  deps: ReducerDeps,
): { state: S; buf: AssistantBuf } {
  switch (event.type) {
    case "session":
      return { state: { ...state, butlerState: { active: true, sessionId: event.sessionId } }, buf };
    case "usage":
      return { state: { ...state, contextTokens: event.contextTokens }, buf };
    case "meta":
      return {
        state: {
          ...state,
          ...(event.model ? { model: event.model } : {}),
          ...(event.contextWindow ? { contextWindow: event.contextWindow } : {}),
          ...(event.mcpConnected !== undefined ? { mcpConnected: event.mcpConnected } : {}),
        },
        buf,
      };
    case "turn-start":
      return { state: { ...state, sending: true }, buf: emptyAssistantBuf() };
    case "user": {
      const recentDup = state.chatMessages.slice(-4).some((m) => m.role === "user" && m.text === event.text);
      if (recentDup) return { state, buf };
      return {
        state: {
          ...state,
          chatMessages: [...state.chatMessages, { id: `user-ext-${deps.now()}`, role: "user", text: event.text, ts: deps.now() }],
        },
        buf,
      };
    }
    case "text":
      return appendAssistantText(state, buf, event.text, deps);
    case "question": {
      // The question card replaces the streamed text run, like a tool call does.
      const nextBuf: AssistantBuf = { buf: "", msgId: null, textSeen: buf.textSeen };
      if (state.chatMessages.some((m) => m.question?.askId === event.askId)) return { state, buf: nextBuf };
      return {
        state: {
          ...state,
          chatMessages: [...state.chatMessages, {
            id: `ask-${event.askId}`,
            role: "question",
            text: event.questions[0]?.question ?? "",
            ts: deps.now(),
            question: { askId: event.askId, questions: event.questions },
          }],
        },
        buf: nextBuf,
      };
    }
    case "question-resolved": {
      const idx = state.chatMessages.findIndex((m) => m.question?.askId === event.askId);
      if (idx === -1) return { state, buf };
      const msg = state.chatMessages[idx];
      if (msg.question?.resolved) return { state, buf };
      const next = [...state.chatMessages];
      next[idx] = { ...msg, question: { ...msg.question!, resolved: { answers: event.answers, reason: event.reason } } };
      return { state: { ...state, chatMessages: next }, buf };
    }
    case "tool": {
      // AskUserQuestion is rendered as its own question card (the `question` event),
      // so a generic tool card for it would be a confusing duplicate. The buffer is
      // left ALONE on purpose: the SDK dispatches the assistant message carrying this
      // tool_use only after canUseTool resolved, i.e. mid-way through the reply that
      // follows the answer — resetting there splits that reply into two bubbles.
      if (event.name === "AskUserQuestion") return { state, buf };
      const id = event.toolId ? `tool-${event.toolId}` : `tool-${deps.now()}-${deps.rand()}`;
      // Reset the streamed-text accumulator (a tool call ends the current text run)
      // but preserve textSeen — it gates the final "result" text.
      const nextBuf: AssistantBuf = { buf: "", msgId: null, textSeen: buf.textSeen };
      return {
        state: {
          ...state,
          chatMessages: [...state.chatMessages, {
            id,
            role: "tool",
            text: formatToolLabel(event.name),
            ts: deps.now(),
            tool: { name: event.name, input: event.input, status: "pending" },
          }],
        },
        buf: nextBuf,
      };
    }
    case "tool-result": {
      const targetId = event.toolId ? `tool-${event.toolId}` : undefined;
      let idx = -1;
      if (targetId) {
        idx = state.chatMessages.findIndex((m) => m.id === targetId);
      } else {
        for (let i = state.chatMessages.length - 1; i >= 0; i--) {
          if (state.chatMessages[i].role === "tool" && state.chatMessages[i].tool?.status === "pending") { idx = i; break; }
        }
      }
      if (idx === -1) return { state, buf };
      const msg = state.chatMessages[idx];
      const next = [...state.chatMessages];
      next[idx] = { ...msg, tool: { ...msg.tool!, output: event.output, status: event.isError ? "error" : "done" } };
      return { state: { ...state, chatMessages: next }, buf };
    }
    case "result": {
      let result = { state, buf };
      if (event.text && !buf.textSeen) {
        if (event.isError) {
          result = {
            state: {
              ...state,
              chatMessages: [...state.chatMessages, { id: `err-${deps.now()}`, role: "activity", text: `Error: ${event.text}`, ts: deps.now() }],
            },
            buf,
          };
        } else {
          result = appendAssistantText(state, buf, event.text, deps);
        }
      }
      const settled = settlePendingTools(result.state);
      return { state: { ...settled, sending: false }, buf: emptyAssistantBuf() };
    }
    case "error": {
      const withMsg: S = {
        ...state,
        chatMessages: [...state.chatMessages, { id: `err-${deps.now()}`, role: "activity", text: `Error: ${event.message}`, ts: deps.now() }],
        sending: false,
      };
      return { state: settlePendingTools(withMsg), buf };
    }
    case "ready":
    default:
      return { state, buf };
  }
}
