// Shared Butler UI types. Extracted from ButlerView.tsx so both the container
// (ButlerView) and its presenter (ButlerViewBody) can reference the same shapes
// without the presenter importing from its own container. Pure type module — no
// runtime values. The streamed-message type lives with the reducer that produces it.

import type { ButlerChatMessage } from "./butler-event-reducer.js";

export interface ButlerState {
  backend?: "claude" | "codex" | "mock";
  active: boolean;
  sessionId: string | null;
  contextTokens?: number;
  model?: string;
  contextWindow?: number;
  mcpConnected?: boolean;
  selectedModel?: string;
  selectedProfile?: string;
}

export interface ButlerCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

export interface ButlerSessionSummary {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  title: string;
  turnCount: number;
  model?: string;
}

export interface ButlerSessionMessage {
  role: "user" | "assistant";
  text: string;
  ts: number;
}

/** A defined butler plus this project's runtime state for it (GET /:id/butlers). */
export interface ButlerListItem {
  id: string;
  name: string;
  model: string;
  active: boolean;
  busy: boolean;
  contextTokens: number;
  contextWindow?: number;
  sessionId: string | null;
  mcpConnected?: boolean;
  backend?: "claude" | "codex" | "mock";
}

/** Per-tab mutable state, keyed by butlerId in ButlerView's tabStates map. */
export interface TabState {
  butlerId: string;
  butlerName: string;
  chatMessages: ButlerChatMessage[];
  butlerState: ButlerState | null;
  backend: "claude" | "codex" | "mock";
  contextTokens: number;
  model: string | undefined;
  contextWindow: number | undefined;
  mcpConnected: boolean | undefined;
  selectedModel: string;
  sending: boolean;
  input: string;
  profiles: string[];
  selectedProfile: string;
  globalProfile: string;
  commands: ButlerCommand[];
  historyOpen: boolean;
  historySessions: ButlerSessionSummary[];
  historyLoading: boolean;
  historyTranscript: { session: ButlerSessionSummary; messages: ButlerSessionMessage[] } | null;
  customizeOpen: boolean;
  customizePrompt: string;
  customizeBusy: boolean;
}
