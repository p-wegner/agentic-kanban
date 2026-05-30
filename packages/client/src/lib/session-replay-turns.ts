import {
  createAgentOutputParser,
  type AgentOutputFormat,
  type DisplayEvent,
} from "./agent-output-parser.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReplayToolCall {
  id: string;
  name: string;
  input: string;
  inputParsed: Record<string, unknown>;
  result?: {
    output: string;
    isError: boolean;
  };
}

export interface ReplayTurn {
  index: number; // 1-based
  thinking?: string;
  text?: string;
  toolCalls: ReplayToolCall[];
  cumulativeCostUsd: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Convert persisted agent output messages into a flat list of replay turns.
 *
 * A "turn" starts at each assistant text event (or at a leading tool_use with no
 * preceding assistant text). Thinking blocks attach to the next turn. Tool results
 * are matched back to their tool_use by id (falling back to the most recent
 * unmatched call). `result` events accumulate cost/token totals which are stamped
 * cumulatively onto each turn.
 *
 * Defensive: tolerates a missing/non-array `messages` argument (returns []), so a
 * malformed or mis-shaped API response can never crash the replay viewer.
 */
export function parseMessagesIntoTurns(
  messages: AgentOutputMessage[] | null | undefined,
  outputFormat: AgentOutputFormat,
): ReplayTurn[] {
  if (!Array.isArray(messages)) return [];

  const parser = createAgentOutputParser(outputFormat);
  const events: DisplayEvent[] = [];

  for (const msg of messages) {
    if (msg.type === "exit") continue;
    if (msg.type === "stderr") continue;
    if (msg.data) {
      events.push(...parser.feed(msg.data + "\n"));
    }
  }
  events.push(...parser.flush());

  const turns: ReplayTurn[] = [];
  let currentTurn: ReplayTurn | null = null;
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let pendingThinking: string | undefined;

  for (const ev of events) {
    if (ev.kind === "thinking") {
      pendingThinking = pendingThinking ? `${pendingThinking}\n\n${ev.text}` : ev.text;
      continue;
    }

    if (ev.kind === "assistant") {
      if (currentTurn) turns.push(currentTurn);
      currentTurn = {
        index: turns.length + 1,
        thinking: pendingThinking,
        text: ev.text,
        toolCalls: [],
        cumulativeCostUsd: totalCostUsd,
        cumulativeInputTokens: totalInputTokens,
        cumulativeOutputTokens: totalOutputTokens,
      };
      pendingThinking = undefined;
      continue;
    }

    if (ev.kind === "tool_use") {
      if (!currentTurn) {
        currentTurn = {
          index: turns.length + 1,
          thinking: pendingThinking,
          toolCalls: [],
          cumulativeCostUsd: totalCostUsd,
          cumulativeInputTokens: totalInputTokens,
          cumulativeOutputTokens: totalOutputTokens,
        };
        pendingThinking = undefined;
      }
      currentTurn.toolCalls.push({
        id: ev.id,
        name: ev.name,
        input: ev.input,
        inputParsed: ev.inputParsed,
      });
      continue;
    }

    if (ev.kind === "tool_result") {
      if (currentTurn) {
        const toolCall =
          ev.toolUseId
            ? currentTurn.toolCalls.find((tc) => tc.id === ev.toolUseId)
            : [...currentTurn.toolCalls].reverse().find((tc) => !tc.result);
        if (toolCall) {
          toolCall.result = { output: ev.output, isError: ev.isError };
        }
      }
      continue;
    }

    if (ev.kind === "result") {
      totalCostUsd += ev.totalCostUsd;
      totalInputTokens += ev.inputTokens;
      totalOutputTokens += ev.outputTokens;
      if (currentTurn) {
        currentTurn.cumulativeCostUsd = totalCostUsd;
        currentTurn.cumulativeInputTokens = totalInputTokens;
        currentTurn.cumulativeOutputTokens = totalOutputTokens;
      }
      continue;
    }
  }

  if (currentTurn) turns.push(currentTurn);
  return turns;
}
