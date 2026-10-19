import { randomUUID } from "node:crypto";

// Stream-json message builders for the mock agent (split out of mock-agent.ts).

export function buildInitMsg(sessionId: string) {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    model: "mock-claude-opus-4",
    cwd: process.cwd(),
  };
}

export function buildToolUseMsg(toolName: string, input: Record<string, unknown>, id?: string) {
  return {
    type: "assistant",
    message: {
      id: id ?? "msg_mock_" + randomUUID().slice(0, 8),
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_mock_" + randomUUID().slice(0, 8),
          name: toolName,
          input,
        },
      ],
      model: "mock-claude-opus-4",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 150, output_tokens: 42 },
    },
  };
}

export function buildAssistantTextMsg(text: string, id?: string) {
  return {
    type: "assistant",
    message: {
      id: id ?? "msg_mock_" + randomUUID().slice(0, 8),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      model: "mock-claude-opus-4",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 150, output_tokens: 42 },
    },
  };
}

export function buildRateLimitMsg(sessionId: string, status: "allowed" | "rejected" = "allowed") {
  return {
    type: "rate_limit_event",
    rate_limit_info: {
      status,
      rateLimitType: "five_hour",
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
      overageStatus: status === "rejected" ? "rejected" : undefined,
      overageDisabledReason: status === "rejected" ? "org_level_disabled" : undefined,
      isUsingOverage: false,
    },
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

export function buildResultMsg(
  sessionId: string,
  text: string,
  startTime: number,
  numTurns: number,
  isError = false,
) {
  const durationMs = Date.now() - startTime;
  return {
    type: "result",
    subtype: isError ? "error" : "success",
    cost_usd: 0.001,
    total_cost_usd: 0.001,
    is_error: isError,
    duration_ms: durationMs,
    duration_api_ms: durationMs,
    num_turns: numTurns,
    result: text,
    session_id: sessionId,
    usage: { input_tokens: 150, output_tokens: 42 },
  };
}
