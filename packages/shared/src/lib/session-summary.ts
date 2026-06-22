export interface TaskSummaryItem {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
}

export interface ToolUsePattern {
  tool: string;
  count: number;
  failedCount: number;
}

export interface RepeatedCommand {
  command: string;
  count: number;
}

export interface SessionSummary {
  overview: string;
  agentSummary: string | null;
  actions: Array<{ type: string; files?: string[]; commands?: string[] }>;
  keyExcerpts: string[];
  errors: string[];
  filesRead: string[];
  filesEdited: string[];
  filesWritten: string[];
  commandsRun: string[];
  model: string;
  tasks: TaskSummaryItem[];
  rateLimits: Array<{ rateLimitType: string; status: string; resetsAt?: number; overageStatus?: string }>;
  toolUsePatterns: ToolUsePattern[];
  repeatedCommands: RepeatedCommand[];
}

export function formatDurationStr(diffMs: number): string {
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}

// ── Copilot event-type constants ──────────────────────────────────────

const COPILOT_SESSION_START_TYPES = new Set([
  "session_start",
  "session_started",
  "session_created",
  "session.start",
  "session.started",
  "session.created",
]);

const COPILOT_TOOL_USE_TYPES = new Set([
  "tool_call",
  "tool_call_start",
  "tool_call_started",
  "tool_use",
  "tool_use_start",
  "tool_use_started",
  "tool.start",
  "tool.started",
  "tool_call.started",
]);

const COPILOT_TOOL_RESULT_TYPES = new Set([
  "tool_result",
  "tool_call_result",
  "tool_call_complete",
  "tool_call_completed",
  "tool.completed",
  "tool_call.completed",
]);

const COPILOT_RESULT_TYPES = new Set([
  "result",
  "done",
  "session_end",
  "session_ended",
  "session.end",
  "session.ended",
  "turn_completed",
  "turn.completed",
  "stats",
]);

// ── Low-level JSON/value helpers ──────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizedType(obj: Record<string, unknown>): string {
  return String(obj.type || obj.event || obj.name || "").toLowerCase().replace(/-/g, "_");
}

function getString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

function contentToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => {
      if (typeof block === "string") return block;
      const record = asRecord(block);
      return record ? getString(record, ["text", "content", "message"]) : "";
    })
    .filter(Boolean)
    .join("\n");
}

// ── Copilot-specific extraction helpers ───────────────────────────────

/** Extract assistant text from Copilot's varied message shapes (CLI nested, REST flat, etc.). */
function extractCopilotAssistantText(obj: Record<string, unknown>): string {
  const type = normalizedType(obj);
  const role = String(obj.role || "").toLowerCase();
  const data = asRecord(obj.data);
  const message = asRecord(obj.message);

  if (type === "assistant.message" && data) {
    return contentToText(data.content)
      || getString(data, ["content", "text", "message"])
      || "";
  }

  if (type === "assistant" || type === "assistant_message" || role === "assistant") {
    return contentToText(obj.content)
      || getString(obj, ["text", "message", "delta"])
      || (message ? contentToText(message.content) || getString(message, ["text", "content", "message"]) : "");
  }

  if (type === "message" && role === "assistant") {
    return contentToText(obj.content) || getString(obj, ["text", "message"]);
  }

  return "";
}

/** Extract tool-use invocation details from Copilot's varied tool-call shapes. */
function extractCopilotToolUse(obj: Record<string, unknown>): {
  id: string;
  name: string;
  input: Record<string, unknown>;
  rawInput: unknown;
} | null {
  const type = normalizedType(obj);
  if (!COPILOT_TOOL_USE_TYPES.has(type) && type !== "tool.execution_start") return null;

  const data = asRecord(obj.data);
  const tool = data || asRecord(obj.tool) || asRecord(obj.tool_call) || asRecord(obj.toolCall) || obj;
  const rawInput = tool.input ?? tool.arguments ?? tool.args ?? tool.parameters ?? tool.command ?? tool.path;
  let inputRecord = asRecord(rawInput) || {};
  if (Object.keys(inputRecord).length === 0 && typeof rawInput === "string") {
    try { inputRecord = JSON.parse(rawInput) as Record<string, unknown>; } catch { /* keep empty */ }
  }
  return {
    id: getString(tool, ["id", "tool_use_id", "toolUseId", "call_id", "callId", "toolCallId"]),
    name: getString(tool, ["name", "tool", "tool_name", "toolName", "kind"]) || "copilot_tool",
    input: inputRecord,
    rawInput,
  };
}

/** Extract tool-result details from Copilot's varied tool-result shapes. */
function extractCopilotToolResult(
  obj: Record<string, unknown>,
  toolNameMap: Map<string, string>,
): { id: string; name: string; output: string; isError: boolean } | null {
  const type = normalizedType(obj);
  if (!COPILOT_TOOL_RESULT_TYPES.has(type) && type !== "tool.execution_complete" && type !== "tool.execution_partial_result") return null;

  const data = asRecord(obj.data);
  const tool = data || asRecord(obj.tool) || asRecord(obj.tool_call) || asRecord(obj.toolCall) || obj;
  const result = asRecord(tool.result);
  const id = getString(tool, ["id", "tool_use_id", "toolUseId", "call_id", "callId", "toolCallId"]);
  const status = String(tool.status || "").toLowerCase();
  return {
    id,
    name: getString(tool, ["name", "tool", "tool_name", "toolName", "kind"])
      || (id ? toolNameMap.get(id) : "")
      || "copilot_tool",
    output: stringifyValue(result?.content ?? result?.detailedContent ?? tool.output ?? tool.result ?? tool.content ?? tool.message ?? tool.error),
    isError: tool.success === false || Boolean(tool.is_error || tool.isError || tool.error) || status === "error" || status === "failed",
  };
}

function getPathLike(input: Record<string, unknown>, rawInput: unknown): string {
  return getString(input, ["file_path", "filePath", "path", "target", "uri"])
    || (typeof rawInput === "string" && !rawInput.includes("\n") ? rawInput : "");
}

function getCommandLike(input: Record<string, unknown>, rawInput: unknown): string {
  return getString(input, ["command", "cmd", "script"])
    || (typeof rawInput === "string" ? rawInput : "");
}

// ── Parse context ─────────────────────────────────────────────────────

/** Mutable accumulator state shared across all handler functions. */
interface ParseContext {
  /** Maps tool-use IDs to tool names for cross-referencing results. */
  toolNameMap: Map<string, string>;
  /** Per-tool invocation and failure counts. */
  toolUseCounts: Map<string, { count: number; failedCount: number }>;
  /** Normalized command → repetition count. */
  commandCounts: Map<string, number>;
  /** File paths read (via Read/view/grep/glob tools). */
  filesRead: Set<string>;
  /** File paths edited (via Edit/apply_patch tools). */
  filesEdited: Set<string>;
  /** File paths written (via Write/create tools). */
  filesWritten: Set<string>;
  /** All shell commands executed, in order. */
  commandsRun: string[];
  /** Up to 10 representative assistant text excerpts (≤300 chars each). */
  keyExcerpts: string[];
  /** Error messages from failed tool calls (≤10). */
  errors: string[];
  /** Most recently observed model name. */
  model: string;
  /** Whether an init/session-start event was seen. */
  initFound: boolean;
  /** All assistant text for the agent summary (joined with separators). */
  agentSummaryParts: string[];
  /** Auto-incrementing counter for task IDs. */
  taskCounter: number;
  /** Task items tracked via TaskCreate/TaskUpdate tool calls. */
  tasksMap: Map<string, TaskSummaryItem>;
  /** Rate-limit events observed during the session. */
  rateLimits: SessionSummary["rateLimits"];
}

// ── Shared accumulator helpers ────────────────────────────────────────

/** Add a text excerpt, truncating to 300 chars and capping at 10 entries. */
function addExcerpt(ctx: ParseContext, text: string): void {
  if (ctx.keyExcerpts.length < 10) {
    ctx.keyExcerpts.push(text.length > 300 ? text.slice(0, 300) + "..." : text);
  }
}

/** Record a shell command, tracking repetition counts. */
function recordCommand(ctx: ParseContext, command: string): void {
  const cmd = command.slice(0, 200);
  ctx.commandsRun.push(cmd);
  const normCmd = cmd.replace(/\s+/g, " ").trim().slice(0, 80);
  ctx.commandCounts.set(normCmd, (ctx.commandCounts.get(normCmd) ?? 0) + 1);
}

/** Increment the tool-use count for a given tool name. */
function incrementToolCount(ctx: ParseContext, toolName: string): void {
  const existing = ctx.toolUseCounts.get(toolName) ?? { count: 0, failedCount: 0 };
  existing.count++;
  ctx.toolUseCounts.set(toolName, existing);
}

// ── Session initialization handlers ───────────────────────────────────

/**
 * Claude streaming: `type: "system", subtype: "init"`.
 * Captures the model name and marks session as initialized.
 */
function tryHandleClaudeInit(ctx: ParseContext, obj: Record<string, unknown>): boolean {
  if (obj.type !== "system" || obj.subtype !== "init") return false;
  ctx.initFound = true;
  ctx.model = (obj.model as string) || "unknown";
  return true;
}

/**
 * Copilot: session start events (session.started, session_created, etc.).
 * Captures model from the start event; falls back to "copilot" if no model found.
 */
function tryHandleCopilotSessionStart(ctx: ParseContext, obj: Record<string, unknown>): boolean {
  if (!COPILOT_SESSION_START_TYPES.has(normalizedType(obj))) return false;
  ctx.initFound = true;
  ctx.model = getString(obj, ["model", "modelId", "model_id"]) || ctx.model || "copilot";
  return true;
}

/**
 * Copilot CLI: `session.model_change`.
 * Updates the tracked model when the user switches mid-session.
 */
function tryHandleCopilotModelChange(ctx: ParseContext, obj: Record<string, unknown>): boolean {
  if (normalizedType(obj) !== "session.model_change") return false;
  const data = asRecord(obj.data);
  if (data) {
    const newModel = getString(data, ["newModel", "model", "modelId", "model_id"]);
    if (newModel) ctx.model = newModel;
  }
  return true;
}

/**
 * Copilot CLI: `session.shutdown`.
 * Updates model from shutdown event, but ignores "copilot" placeholder.
 */
function tryHandleCopilotShutdown(ctx: ParseContext, obj: Record<string, unknown>): boolean {
  if (normalizedType(obj) !== "session.shutdown") return false;
  const data = asRecord(obj.data);
  if (data) {
    const newModel = getString(data, ["model", "modelId", "model_id"]) || ctx.model;
    if (newModel && newModel !== "copilot") ctx.model = newModel;
  }
  return true;
}

// ── Copilot tool activity handlers ────────────────────────────────────

/**
 * Copilot: tool invocation events (tool_call, tool_call.started, tool.execution_start, etc.).
 * Records the tool call, maps IDs to names, and classifies file/command activity
 * by tool name (view/read/grep/glob → read, edit/write/create → edit/write,
 * bash/powershell/shell → command).
 */
function tryHandleCopilotToolUse(ctx: ParseContext, obj: Record<string, unknown>): boolean {
  const copilotToolUse = extractCopilotToolUse(obj);
  if (!copilotToolUse) return false;

  if (copilotToolUse.id) ctx.toolNameMap.set(copilotToolUse.id, copilotToolUse.name);
  incrementToolCount(ctx, copilotToolUse.name);

  const toolName = copilotToolUse.name.toLowerCase();
  const pathLike = getPathLike(copilotToolUse.input, copilotToolUse.rawInput);
  const commandLike = getCommandLike(copilotToolUse.input, copilotToolUse.rawInput);
  if (["view", "read", "grep", "glob"].includes(toolName) && pathLike) {
    ctx.filesRead.add(pathLike);
  } else if (["edit", "write", "create", "apply_patch"].includes(toolName) && pathLike) {
    if (toolName === "create" || toolName === "write") ctx.filesWritten.add(pathLike);
    else ctx.filesEdited.add(pathLike);
  } else if (["bash", "powershell", "shell", "shell_command"].includes(toolName) && commandLike) {
    recordCommand(ctx, commandLike);
  }
  return true;
}

/**
 * Copilot: tool result events (tool.completed, tool.execution_complete, etc.).
 * Records errors from failed tool calls and increments failure counts.
 */
function tryHandleCopilotToolResult(ctx: ParseContext, obj: Record<string, unknown>): boolean {
  const copilotToolResult = extractCopilotToolResult(obj, ctx.toolNameMap);
  if (!copilotToolResult) return false;

  if (copilotToolResult.isError) {
    if (ctx.errors.length < 10) {
      ctx.errors.push(`${copilotToolResult.name}: ${copilotToolResult.output.length > 200 ? copilotToolResult.output.slice(0, 200) + "..." : copilotToolResult.output}`);
    }
    const entry = ctx.toolUseCounts.get(copilotToolResult.name);
    if (entry) entry.failedCount++;
  }
  return true;
}

// ── Copilot completion handlers ───────────────────────────────────────

/**
 * Copilot: turn/session completion events (done, stats, turn.completed, etc.).
 * Excludes bare `type: "result"` (handled separately for Claude).
 * Updates model and captures result text as agent summary.
 */
function tryHandleCopilotResultTypes(ctx: ParseContext, obj: Record<string, unknown>): boolean {
  const copilotType = normalizedType(obj);
  if (copilotType === "result" || !COPILOT_RESULT_TYPES.has(copilotType)) return false;

  const usage = asRecord(obj.usage) || asRecord(obj.stats) || obj;
  ctx.model = getString(obj, ["model", "modelId", "model_id"]) || getString(usage, ["model", "modelId", "model_id"]) || ctx.model;
  const resultText = getString(obj, ["result", "message", "summary"]);
  if (resultText) ctx.agentSummaryParts.push(resultText);
  return true;
}

/**
 * Copilot: generic assistant text fallback.
 * Catches Copilot assistant messages that weren't matched by more specific handlers.
 * Extracts text via `extractCopilotAssistantText`, records excerpts, and updates model.
 */
function tryHandleCopilotAssistantFallback(ctx: ParseContext, obj: Record<string, unknown>): boolean {
  const copilotAssistantText = extractCopilotAssistantText(obj);
  if (!copilotAssistantText) return false;

  const data = asRecord(obj.data);
  ctx.model = getString(data || obj, ["model", "modelId", "model_id"]) || ctx.model;
  addExcerpt(ctx, copilotAssistantText);
  ctx.agentSummaryParts.push(copilotAssistantText);
  return true;
}

// ── Claude streaming format handlers ──────────────────────────────────

/**
 * Claude streaming: `type: "assistant"` messages with content blocks.
 * Iterates `message.content[]` array, dispatching text blocks to
 * `handleClaudeTextBlock` and tool_use blocks to `handleClaudeToolUseBlock`.
 * Falls back to `extractCopilotAssistantText` when content is empty
 * (Copilot CLI nested format sends assistant text without content blocks).
 */
function tryHandleClaudeAssistant(ctx: ParseContext, obj: Record<string, unknown>): boolean {
  if (obj.type !== "assistant") return false;

  const message = obj.message as Record<string, unknown> | undefined;
  const content = Array.isArray(message?.content)
    ? message.content as Array<Record<string, unknown>>
    : [];
  const msgModel = (message?.model as string) || "";
  if (msgModel) ctx.model = msgModel;

  for (const block of content) {
    if (block.type === "text") {
      handleClaudeTextBlock(ctx, block);
    } else if (block.type === "tool_use") {
      handleClaudeToolUseBlock(ctx, block);
    }
  }

  // Fallback: Copilot CLI nested format sends assistant text without content blocks
  if (content.length === 0) {
    const text = extractCopilotAssistantText(obj);
    if (text) {
      addExcerpt(ctx, text);
      ctx.agentSummaryParts.push(text);
      ctx.model = getString(obj, ["model", "modelId", "model_id"]) || ctx.model;
    }
  }
  return true;
}

/** Claude streaming: text content block within an assistant message. Records excerpt and summary. */
function handleClaudeTextBlock(ctx: ParseContext, block: Record<string, unknown>): void {
  const text = (block.text as string) || "";
  if (!text) return;
  addExcerpt(ctx, text);
  ctx.agentSummaryParts.push(text);
}

/**
 * Claude streaming: tool_use content block within an assistant message.
 * Dispatches by tool name:
 * - Read/Edit/Write → file tracking
 * - Bash → command tracking
 * - TaskCreate/TaskUpdate → in-session task tracking
 */
function handleClaudeToolUseBlock(ctx: ParseContext, block: Record<string, unknown>): void {
  const toolUseId = (block.id as string) || "";
  const toolName = (block.name as string) || "unknown";
  if (toolUseId) ctx.toolNameMap.set(toolUseId, toolName);
  incrementToolCount(ctx, toolName);

  const input = block.input as Record<string, unknown> | undefined;

  if (toolName === "Read" && input?.file_path) {
    ctx.filesRead.add(input.file_path as string);
  } else if (toolName === "Edit" && input?.file_path) {
    ctx.filesEdited.add(input.file_path as string);
  } else if (toolName === "Write" && input?.file_path) {
    ctx.filesWritten.add(input.file_path as string);
  } else if (toolName === "Bash" && input?.command) {
    recordCommand(ctx, input.command as string);
  } else if (toolName === "TaskCreate" && input?.subject) {
    ctx.taskCounter++;
    const id = String(ctx.taskCounter);
    ctx.tasksMap.set(id, {
      id,
      subject: input.subject as string,
      description: input.description as string | undefined,
      status: "pending",
    });
  } else if (toolName === "TaskUpdate" && input?.taskId) {
    const id = String(input.taskId);
    const existing = ctx.tasksMap.get(id);
    if (existing) {
      if (input.status) existing.status = input.status as TaskSummaryItem["status"];
      if (input.subject) existing.subject = input.subject as string;
      if (input.description) existing.description = input.description as string;
    }
  }
}

/**
 * Claude streaming: `type: "user"` messages with tool_result content blocks.
 * Records errors from failed tool calls and captures Agent sub-agent output.
 */
function tryHandleClaudeUser(ctx: ParseContext, obj: Record<string, unknown>): boolean {
  if (obj.type !== "user") return false;

  const message = obj.message as Record<string, unknown> | undefined;
  const content = (message?.content as Array<Record<string, unknown>>) || [];

  for (const block of content) {
    if (block.type === "tool_result") {
      const toolUseId = (block.tool_use_id as string) || "";
      const toolName = toolUseId ? (ctx.toolNameMap.get(toolUseId) || "unknown") : "unknown";
      const rawContent = block.content;
      const output = typeof rawContent === "string"
        ? rawContent
        : JSON.stringify(rawContent);
      if (block.is_error as boolean) {
        if (ctx.errors.length < 10) {
          ctx.errors.push(`${toolName}: ${output.length > 200 ? output.slice(0, 200) + "..." : output}`);
        }
        const entry = ctx.toolUseCounts.get(toolName);
        if (entry) entry.failedCount++;
      } else if (toolName === "Agent" && output) {
        ctx.agentSummaryParts.push(output);
      }
    }
  }
  return true;
}

/**
 * Claude streaming: `type: "result"` — turn completion.
 * Captures the result text as agent summary and updates model from usage stats.
 */
function tryHandleClaudeResult(ctx: ParseContext, obj: Record<string, unknown>): boolean {
  if (obj.type !== "result") return false;

  const resultText = (obj.result as string) || "";
  if (resultText) ctx.agentSummaryParts.push(resultText);
  const usage = asRecord(obj.usage) || asRecord(obj.stats) || obj;
  ctx.model = getString(obj, ["model", "modelId", "model_id"]) || getString(usage, ["model", "modelId", "model_id"]) || ctx.model;
  return true;
}

// ── Rate limit handler ────────────────────────────────────────────────

/**
 * Claude streaming: `type: "rate_limit_event"`.
 * Records rate-limit info (type, status, reset time, overage) from the event payload.
 */
function tryHandleRateLimitEvent(ctx: ParseContext, obj: Record<string, unknown>): boolean {
  if (obj.type !== "rate_limit_event") return false;

  const rli = obj.rate_limit_info as Record<string, unknown> | undefined;
  if (rli) {
    ctx.rateLimits.push({
      rateLimitType: (rli.rateLimitType as string) || "unknown",
      status: (rli.status as string) || "unknown",
      resetsAt: rli.resetsAt as number | undefined,
      overageStatus: rli.overageStatus as string | undefined,
    });
  }
  return true;
}

// ── Codex exec --json streaming format handlers ───────────────────────

/** Codex: `thread.started` — session initialized (no model info in this event). */
function tryHandleCodexThreadStarted(ctx: ParseContext, obj: Record<string, unknown>): boolean {
  if (obj.type !== "thread.started") return false;
  ctx.initFound = true;
  return true;
}

/** Codex: `turn.completed` — aggregate stats turn end (no summary/model emitted). */
function tryHandleCodexTurnCompleted(_ctx: ParseContext, obj: Record<string, unknown>): boolean {
  if (obj.type !== "turn.completed") return false;
  return true;
}

/** Codex: `turn.failed` — records the failure reason as an error. */
function tryHandleCodexTurnFailed(ctx: ParseContext, obj: Record<string, unknown>): boolean {
  if (obj.type !== "turn.failed") return false;
  const error = asRecord(obj.error);
  const msg = getString(error ?? {}, ["message"]) || "Turn failed";
  if (ctx.errors.length < 10) ctx.errors.push(`codex: ${msg}`);
  return true;
}

/**
 * Codex: `item.started`, `item.completed`, `item.updated` — tool/activity events.
 * Dispatches to sub-handlers based on `item.type`:
 * - `agent_message` → text output from the agent
 * - `command_execution` → shell commands with exit codes
 * - `mcp_tool_call` → MCP tool invocations
 */
function tryHandleCodexItemEvent(ctx: ParseContext, obj: Record<string, unknown>): boolean {
  const type = obj.type as string;
  if (type !== "item.started" && type !== "item.completed" && type !== "item.updated") return false;

  const item = asRecord(obj.item);
  if (!item) return true; // handled but no-op

  const itemType = String(item.type || "");
  const itemId = getString(item, ["id"]);

  if (itemType === "agent_message") {
    handleCodexAgentMessage(ctx, item, type);
  } else if (itemType === "command_execution") {
    handleCodexCommandExecution(ctx, item, type, itemId);
  } else if (itemType === "mcp_tool_call") {
    handleCodexMcpToolCall(ctx, item, type, itemId);
  }
  return true;
}

/** Codex: `agent_message` item — captures agent text output on `item.completed`. */
function handleCodexAgentMessage(ctx: ParseContext, item: Record<string, unknown>, eventType: string): void {
  if (eventType !== "item.completed") return;
  const text = getString(item, ["text"]);
  if (text) {
    addExcerpt(ctx, text);
    ctx.agentSummaryParts.push(text);
  }
}

/**
 * Codex: `command_execution` item — tracks shell commands.
 * On `item.started`: records the command and increments shell tool count.
 * On `item.completed`: records non-zero exit codes as errors.
 */
function handleCodexCommandExecution(
  ctx: ParseContext,
  item: Record<string, unknown>,
  eventType: string,
  itemId: string,
): void {
  if (eventType === "item.started") {
    const command = getString(item, ["command"]);
    if (command) {
      recordCommand(ctx, command);
      incrementToolCount(ctx, "shell");
      if (itemId) ctx.toolNameMap.set(itemId, "shell");
    }
  } else if (eventType === "item.completed") {
    const exitCode = item.exit_code as number | null | undefined;
    if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
      const output = getString(item, ["aggregated_output"]);
      const entry = ctx.toolUseCounts.get("shell");
      if (entry) entry.failedCount++;
      if (ctx.errors.length < 10) {
        ctx.errors.push(`shell: ${output ? output.slice(0, 200) : `exit code ${exitCode}`}`);
      }
    }
  }
}

/**
 * Codex: `mcp_tool_call` item — tracks MCP tool invocations.
 * On `item.started`/`in_progress`: records the call, classifies file activity by tool name.
 * On `item.completed`: records failures when status is "failed"/"error".
 */
function handleCodexMcpToolCall(
  ctx: ParseContext,
  item: Record<string, unknown>,
  eventType: string,
  itemId: string,
): void {
  const toolName = getString(item, ["name"]) || "mcp_tool";
  const itemStatus = String(item.status || "");

  if (eventType === "item.started" || itemStatus === "in_progress") {
    if (itemId) ctx.toolNameMap.set(itemId, toolName);
    incrementToolCount(ctx, toolName);

    const args = asRecord(item.args) ?? {};
    const pathLike = getPathLike(args, undefined);
    const toolLower = toolName.toLowerCase();
    if (["view", "read", "grep", "glob"].includes(toolLower) && pathLike) {
      ctx.filesRead.add(pathLike);
    } else if (["edit", "write", "create"].includes(toolLower) && pathLike) {
      if (toolLower === "create" || toolLower === "write") ctx.filesWritten.add(pathLike);
      else ctx.filesEdited.add(pathLike);
    }
  } else if (eventType === "item.completed") {
    const itemStatus2 = String(item.status || "");
    if (itemStatus2 === "failed" || itemStatus2 === "error") {
      const entry = ctx.toolUseCounts.get(toolName);
      if (entry) entry.failedCount++;
      const result = getString(item, ["result"]);
      if (ctx.errors.length < 10) {
        ctx.errors.push(`${toolName}: ${result ? result.slice(0, 200) : "failed"}`);
      }
    }
  }
}

// ── Main parser function ──────────────────────────────────────────────

/**
 * Parse JSONL session output rows into a structured `SessionSummary`.
 *
 * Handles three agent provider formats:
 * - **Claude** streaming JSON (`type: "system"`, `"assistant"`, `"user"`, `"result"`)
 * - **Copilot** JSONL (`session.started`, `tool_call.*`, `assistant_message`, etc.)
 * - **Codex** exec --json (`thread.started`, `item.started/completed`, `turn.*`)
 *
 * Each provider's events are handled by dedicated `tryHandle*` functions that
 * check the event type, update the shared `ParseContext`, and return `true`
 * if the event was handled. The dispatch chain is ordered by specificity:
 * init events → tool activity → completions → fallbacks → Codex events.
 */
export function parseSessionSummary(
  rows: Array<{ type: string; data: string | null }>,
): SessionSummary {
  const ctx: ParseContext = {
    toolNameMap: new Map(),
    toolUseCounts: new Map(),
    commandCounts: new Map(),
    filesRead: new Set(),
    filesEdited: new Set(),
    filesWritten: new Set(),
    commandsRun: [],
    keyExcerpts: [],
    errors: [],
    model: "",
    initFound: false,
    agentSummaryParts: [],
    taskCounter: 0,
    tasksMap: new Map(),
    rateLimits: [],
  };

  for (const row of rows) {
    if (row.type !== "stdout" || !row.data) continue;

    const lines = row.data.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      // Session initialization (Claude + Copilot)
      if (tryHandleClaudeInit(ctx, obj)) continue;
      if (tryHandleCopilotSessionStart(ctx, obj)) continue;
      if (tryHandleCopilotModelChange(ctx, obj)) continue;
      if (tryHandleCopilotShutdown(ctx, obj)) continue;

      // Tool activity (Copilot)
      if (tryHandleCopilotToolUse(ctx, obj)) continue;
      if (tryHandleCopilotToolResult(ctx, obj)) continue;

      // Turn/session completion (Copilot non-"result" result types)
      if (tryHandleCopilotResultTypes(ctx, obj)) continue;

      // Claude streaming format
      if (tryHandleClaudeAssistant(ctx, obj)) continue;
      if (tryHandleClaudeUser(ctx, obj)) continue;
      if (tryHandleClaudeResult(ctx, obj)) continue;

      // Copilot assistant text fallback (catches remaining Copilot messages)
      if (tryHandleCopilotAssistantFallback(ctx, obj)) continue;

      // Rate limiting
      if (tryHandleRateLimitEvent(ctx, obj)) continue;

      // Codex exec --json streaming format
      if (tryHandleCodexThreadStarted(ctx, obj)) continue;
      if (tryHandleCodexTurnCompleted(ctx, obj)) continue;
      if (tryHandleCodexTurnFailed(ctx, obj)) continue;
      if (tryHandleCodexItemEvent(ctx, obj)) continue;
    }
  }

  // ── Build result ──────────────────────────────────────────────────

  const actions: Array<{ type: string; files?: string[]; commands?: string[] }> = [];
  if (ctx.filesRead.size > 0) actions.push({ type: "read", files: [...ctx.filesRead] });
  if (ctx.filesEdited.size > 0) actions.push({ type: "edit", files: [...ctx.filesEdited] });
  if (ctx.filesWritten.size > 0) actions.push({ type: "write", files: [...ctx.filesWritten] });
  if (ctx.commandsRun.length > 0) actions.push({ type: "command", commands: ctx.commandsRun });

  const parts: string[] = [];
  if (ctx.initFound) parts.push(`Agent session using ${ctx.model}`);
  if (ctx.filesRead.size > 0) parts.push(`read ${ctx.filesRead.size} file${ctx.filesRead.size !== 1 ? "s" : ""}`);
  if (ctx.filesEdited.size > 0) parts.push(`edited ${ctx.filesEdited.size} file${ctx.filesEdited.size !== 1 ? "s" : ""}`);
  if (ctx.filesWritten.size > 0) parts.push(`wrote ${ctx.filesWritten.size} file${ctx.filesWritten.size !== 1 ? "s" : ""}`);
  if (ctx.commandsRun.length > 0) parts.push(`ran ${ctx.commandsRun.length} command${ctx.commandsRun.length !== 1 ? "s" : ""}`);
  const overview = parts.length > 0 ? parts.join(", ") : "No activity recorded";

  const agentSummary = ctx.agentSummaryParts.length > 0 ? ctx.agentSummaryParts.join("\n\n---\n\n") : null;

  const toolUsePatterns: ToolUsePattern[] = [...ctx.toolUseCounts.entries()]
    .map(([tool, { count, failedCount }]) => ({ tool, count, failedCount }))
    .sort((a, b) => b.count - a.count);

  const repeatedCommands: RepeatedCommand[] = [...ctx.commandCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count);

  return {
    overview,
    agentSummary,
    actions,
    keyExcerpts: ctx.keyExcerpts,
    errors: ctx.errors,
    filesRead: [...ctx.filesRead],
    filesEdited: [...ctx.filesEdited],
    filesWritten: [...ctx.filesWritten],
    commandsRun: ctx.commandsRun,
    model: ctx.model,
    tasks: [...ctx.tasksMap.values()],
    rateLimits: ctx.rateLimits,
    toolUsePatterns,
    repeatedCommands,
  };
}

// ── Friction stats ────────────────────────────────────────────────────

/**
 * Compact, fleet-aggregatable friction metrics derived from a parsed session
 * summary. Persisted alongside the cost/token stats in `sessions.stats` so the
 * insights endpoint can roll them up without re-parsing transcripts.
 *
 * Bounded in size: `tools` is bounded by the number of distinct tool names a
 * session used (~15-20), and `repeatedCommands` is capped + truncated.
 */
export interface SessionFrictionStats {
  /** Total tool invocations across all tools. */
  totalToolCalls: number;
  /** Tool invocations that returned an error result. */
  failedToolCalls: number;
  /** Number of distinct error excerpts captured. */
  errorCount: number;
  /** Per-tool call/failure counts (the denominator for fail-rate analysis). */
  tools: ToolUsePattern[];
  /** Commands the agent ran 2+ times within the session (a wasted-turn signal). */
  repeatedCommands: RepeatedCommand[];
}

export function computeFrictionStats(
  summary: Pick<SessionSummary, "toolUsePatterns" | "repeatedCommands" | "errors">,
  opts?: { maxRepeatedCommands?: number; maxCommandLength?: number },
): SessionFrictionStats {
  const maxCmds = opts?.maxRepeatedCommands ?? 8;
  const maxLen = opts?.maxCommandLength ?? 100;

  let totalToolCalls = 0;
  let failedToolCalls = 0;
  for (const t of summary.toolUsePatterns) {
    totalToolCalls += t.count;
    failedToolCalls += t.failedCount;
  }

  const repeatedCommands = summary.repeatedCommands
    .slice(0, maxCmds)
    .map((rc) => ({
      command: rc.command.length > maxLen ? rc.command.slice(0, maxLen) : rc.command,
      count: rc.count,
    }));

  return {
    totalToolCalls,
    failedToolCalls,
    errorCount: summary.errors.length,
    tools: summary.toolUsePatterns,
    repeatedCommands,
  };
}
