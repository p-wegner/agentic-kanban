import type { ButlerCommand, ButlerQuestion, ButlerQuestionAnswer, ButlerQuestionOption } from "@agentic-kanban/shared";
// #704: moved to shared/src/types/api/. Re-exported so importers of this module are unchanged.
export type { ButlerCommand, ButlerQuestion, ButlerQuestionAnswer, ButlerQuestionOption };
/**
 * Shared type/interface contracts for the butler SDK service (#465 decomposition).
 * Pure types — no behavior — split out so every sub-module can depend on the
 * shapes without pulling in the modules that implement them.
 */
import type { ChildProcess } from "node:child_process";
import type { PermissionResult, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderName } from "../agent-provider.js";
import type { Pushable } from "./pushable.js";









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
  /** The butler asked a structured question; the chat renders choice chips for it. */
  | { type: "question"; askId: string; questions: ButlerQuestion[] }
  /** The parked question is over — answered by the user, or denied (timeout/abort/stop). */
  | { type: "question-resolved"; askId: string; answers?: ButlerQuestionAnswer[]; reason?: string }
  | { type: "error"; message: string };

export type Listener = (e: ButlerEvent) => void;

/** A persisted conversation turn, replayed when the chat UI reloads. */
export interface ButlerTurn {
  role: "user" | "assistant" | "question";
  text: string;
  ts: number;
  /** Only for role "question": the asked questions plus what the user picked.
   *  Only ANSWERED questions are recorded, so a reload never resurrects a parked
   *  question as answerable (its turn is long gone — #460). */
  question?: { askId: string; questions: ButlerQuestion[]; answers: ButlerQuestionAnswer[] };
}

export interface ButlerSession {
  projectId: string;
  /** Which butler (definition id) this session belongs to. "default" is the
   *  legacy/always-present butler; others are user-defined named butlers. */
  butlerId: string;
  /** Composite map key: plain projectId for the default butler (backward compat),
   *  `${projectId}::${butlerId}` for any other. */
  key: string;
  backend: "claude" | "codex" | "mock";
  input?: Pushable<SDKUserMessage>;
  sessionId?: string;
  abort: AbortController;
  process?: ChildProcess;
  interrupted?: boolean;
  busy: boolean;
  contextTokens: number;
  transcript: ButlerTurn[];
  model?: string;
  contextWindow?: number;
  mcpConnected?: boolean;
  /** The active Claude profile this session was started with (per-project override or global). */
  claudeProfile?: string;
  /** Live Query handle — exposes control requests (setModel, supportedCommands). */
  query?: Query;
  /** Slash commands available to this session, fetched once after init (for the UI autocomplete). */
  commands?: ButlerCommand[];
  repoPath: string;
  systemPromptAppend: string;
  profile?: { provider: ProviderName; name: string };
  agentCommand?: string;
  agentArgs?: string;
  /** For a codex butler running under an OAuth license: the CODEX_HOME dir to spawn
   *  under (its own auth.json + rollouts). Set when `profile` was reduced to "default". */
  codexHome?: string;
  /** AskUserQuestion calls parked waiting for a human answer, keyed by askId. */
  pendingQuestions: Map<string, PendingButlerQuestion>;
}

/** A parked AskUserQuestion: the SDK turn is suspended on `settle`. */
export interface PendingButlerQuestion {
  askId: string;
  questions: ButlerQuestion[];
  /** The raw AskUserQuestion tool input, kept so the answer can be shaped from it. */
  input: Record<string, unknown>;
  /** Resolves the canUseTool promise exactly once and clears the timer/abort hook. */
  settle: (result: PermissionResult) => void;
}

export interface ButlerSessionState {
  butlerId: string;
  backend: "claude" | "codex" | "mock";
  sessionId?: string;
  active: boolean;
  busy: boolean;
  contextTokens: number;
  model?: string;
  contextWindow?: number;
  mcpConnected?: boolean;
  claudeProfile?: string;
}
