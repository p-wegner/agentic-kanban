export type AgentStreamProvider = "claude" | "codex" | "copilot" | "pi";

export interface AgentDisplayInitEvent {
  kind: "init";
  model: string;
  sessionId: string;
  cwd: string;
  tools: string[];
  mcpServers: { name: string; status: string }[];
  permissionMode: string;
}

export interface AgentDisplayAssistantEvent {
  kind: "assistant";
  text: string;
  model: string;
}

export interface AgentDisplayThinkingEvent {
  kind: "thinking";
  text: string;
}

export interface AgentDisplayResultEvent {
  kind: "result";
  success: boolean;
  durationMs: number;
  result: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface AgentDisplayToolUseEvent {
  kind: "tool_use";
  id: string;
  name: string;
  input: string;
  inputParsed: Record<string, unknown>;
}

export interface AgentDisplayToolResultEvent {
  kind: "tool_result";
  toolName: string;
  toolUseId: string;
  output: string;
  isError: boolean;
  images?: { mediaType: string; data: string }[];
}

export interface AgentDisplayImageEvent {
  kind: "image";
  mediaType: string;
  data: string;
}

export interface AgentDisplayTaskStartedEvent {
  kind: "task_started";
  taskId: string;
  toolUseId: string;
  description: string;
  taskType: string;
}

export interface AgentDisplayNotificationEvent {
  kind: "notification";
  key: string;
  text: string;
  priority: string;
}

export interface AgentDisplayRateLimitEvent {
  kind: "rate_limit";
  status: string;
  resetsAt: number;
  rateLimitType: string;
  overageStatus?: string;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
}

export interface AgentDisplayRawEvent {
  kind: "raw";
  text: string;
}

export type AgentDisplayEvent =
  | AgentDisplayInitEvent
  | AgentDisplayAssistantEvent
  | AgentDisplayThinkingEvent
  | AgentDisplayResultEvent
  | AgentDisplayToolUseEvent
  | AgentDisplayToolResultEvent
  | AgentDisplayImageEvent
  | AgentDisplayTaskStartedEvent
  | AgentDisplayNotificationEvent
  | AgentDisplayRateLimitEvent
  | AgentDisplayRawEvent;

export interface ParsedStreamEvent {
  providerSessionId?: string;
  exitPlanModeDenied?: boolean;
  stats?: {
    durationMs: number;
    totalCostUsd: number;
    inputTokens: number;
    outputTokens: number;
    contextTokens?: number;
    numTurns: number;
    model: string;
    success: boolean;
    agentSummary?: string;
  };
  turnComplete?: boolean;
  liveStats?: {
    model: string;
    contextTokens: number;
    toolUses?: number;
    subagentDelta?: number;
  };
  toolActivity?: {
    name: string;
    input: Record<string, unknown>;
    toolUseId?: string;
  };
  toolResult?: {
    toolUseId: string;
    images?: Array<{ mediaType: string; data: string }>;
    agentResultText?: string;
  };
  assistantText?: string;
  todos?: Array<{ subject: string; status: string }>;
  rateLimitInfo?: {
    status: string;
    rateLimitType: string;
    resetsAt?: number;
    retryAfter?: string;
    message?: string;
    overageStatus?: string;
    overageDisabledReason?: string;
    isUsingOverage?: boolean;
  };
  displayEvents?: AgentDisplayEvent[];
}

export interface ParseContext {
  toolNames?: Map<string, string>;
  model?: string;
  lastErrorSignature?: string;
}
