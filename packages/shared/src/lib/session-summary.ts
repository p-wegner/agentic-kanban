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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizedType(obj: Record<string, unknown>): string {
  return String(obj.type || obj.event || obj.name || "").toLowerCase();
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

function extractCopilotAssistantText(obj: Record<string, unknown>): string {
  const type = normalizedType(obj);
  const role = String(obj.role || "").toLowerCase();
  const message = asRecord(obj.message);

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

function extractCopilotToolUse(obj: Record<string, unknown>): {
  id: string;
  name: string;
  input: Record<string, unknown>;
  rawInput: unknown;
} | null {
  if (!COPILOT_TOOL_USE_TYPES.has(normalizedType(obj))) return null;

  const tool = asRecord(obj.tool) || asRecord(obj.tool_call) || asRecord(obj.toolCall) || obj;
  const rawInput = tool.input ?? tool.arguments ?? tool.args ?? tool.parameters ?? tool.command ?? tool.path;
  return {
    id: getString(tool, ["id", "tool_use_id", "toolUseId", "call_id", "callId"]),
    name: getString(tool, ["name", "tool", "tool_name", "toolName", "kind"]) || "copilot_tool",
    input: asRecord(rawInput) || {},
    rawInput,
  };
}

function extractCopilotToolResult(
  obj: Record<string, unknown>,
  toolNameMap: Map<string, string>,
): { id: string; name: string; output: string; isError: boolean } | null {
  if (!COPILOT_TOOL_RESULT_TYPES.has(normalizedType(obj))) return null;

  const tool = asRecord(obj.tool) || asRecord(obj.tool_call) || asRecord(obj.toolCall) || obj;
  const id = getString(tool, ["id", "tool_use_id", "toolUseId", "call_id", "callId"]);
  const status = String(tool.status || "").toLowerCase();
  return {
    id,
    name: getString(tool, ["name", "tool", "tool_name", "toolName", "kind"])
      || (id ? toolNameMap.get(id) : "")
      || "copilot_tool",
    output: stringifyValue(tool.output ?? tool.result ?? tool.content ?? tool.message ?? tool.error),
    isError: Boolean(tool.is_error || tool.isError || tool.error) || status === "error" || status === "failed",
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

export function parseSessionSummary(
  rows: Array<{ type: string; data: string | null }>,
): SessionSummary {
  const toolNameMap = new Map<string, string>();
  const toolUseCounts = new Map<string, { count: number; failedCount: number }>();
  const commandCounts = new Map<string, number>();

  const filesRead = new Set<string>();
  const filesEdited = new Set<string>();
  const filesWritten = new Set<string>();
  const commandsRun: string[] = [];
  const keyExcerpts: string[] = [];
  const errors: string[] = [];
  let model = "";
  let initFound = false;
  const agentSummaryParts: string[] = [];
  let taskCounter = 0;
  const tasksMap = new Map<string, TaskSummaryItem>();
  const rateLimits: SessionSummary["rateLimits"] = [];

  for (const row of rows) {
    if (row.type !== "stdout" || !row.data) continue;

    const lines = row.data.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const type = obj.type as string;
      const copilotType = normalizedType(obj);

      if (type === "system" && obj.subtype === "init") {
        initFound = true;
        model = (obj.model as string) || "unknown";
        continue;
      }

      if (COPILOT_SESSION_START_TYPES.has(copilotType)) {
        initFound = true;
        model = getString(obj, ["model", "modelId", "model_id"]) || model || "copilot";
        continue;
      }

      const copilotToolUse = extractCopilotToolUse(obj);
      if (copilotToolUse) {
        if (copilotToolUse.id) toolNameMap.set(copilotToolUse.id, copilotToolUse.name);
        const existing = toolUseCounts.get(copilotToolUse.name) ?? { count: 0, failedCount: 0 };
        existing.count++;
        toolUseCounts.set(copilotToolUse.name, existing);

        const toolName = copilotToolUse.name.toLowerCase();
        const pathLike = getPathLike(copilotToolUse.input, copilotToolUse.rawInput);
        const commandLike = getCommandLike(copilotToolUse.input, copilotToolUse.rawInput);
        if (["view", "read", "grep", "glob"].includes(toolName) && pathLike) {
          filesRead.add(pathLike);
        } else if (["edit", "write", "create", "apply_patch"].includes(toolName) && pathLike) {
          if (toolName === "create" || toolName === "write") filesWritten.add(pathLike);
          else filesEdited.add(pathLike);
        } else if (["bash", "powershell", "shell", "shell_command"].includes(toolName) && commandLike) {
          const cmd = commandLike.slice(0, 200);
          commandsRun.push(cmd);
          const normCmd = cmd.replace(/\s+/g, " ").trim().slice(0, 80);
          commandCounts.set(normCmd, (commandCounts.get(normCmd) ?? 0) + 1);
        }
        continue;
      }

      const copilotToolResult = extractCopilotToolResult(obj, toolNameMap);
      if (copilotToolResult) {
        if (copilotToolResult.isError) {
          if (errors.length < 10) {
            errors.push(`${copilotToolResult.name}: ${copilotToolResult.output.length > 200 ? copilotToolResult.output.slice(0, 200) + "..." : copilotToolResult.output}`);
          }
          const entry = toolUseCounts.get(copilotToolResult.name);
          if (entry) entry.failedCount++;
        }
        continue;
      }

      if (copilotType !== "result" && COPILOT_RESULT_TYPES.has(copilotType)) {
        const usage = asRecord(obj.usage) || asRecord(obj.stats) || obj;
        model = getString(obj, ["model", "modelId", "model_id"]) || getString(usage, ["model", "modelId", "model_id"]) || model;
        const resultText = getString(obj, ["result", "message", "summary"]);
        if (resultText) agentSummaryParts.push(resultText);
        continue;
      }

      if (type === "assistant") {
        const message = obj.message as Record<string, unknown> | undefined;
        const content = Array.isArray(message?.content)
          ? message.content as Array<Record<string, unknown>>
          : [];
        const msgModel = (message?.model as string) || "";
        if (msgModel) model = msgModel;

        for (const block of content) {
          if (block.type === "text") {
            const text = (block.text as string) || "";
            if (text) {
              if (keyExcerpts.length < 10) {
                keyExcerpts.push(text.length > 300 ? text.slice(0, 300) + "..." : text);
              }
              agentSummaryParts.push(text);
            }
          } else if (block.type === "tool_use") {
            const toolUseId = (block.id as string) || "";
            const toolName = (block.name as string) || "unknown";
            if (toolUseId) toolNameMap.set(toolUseId, toolName);
            const existing = toolUseCounts.get(toolName) ?? { count: 0, failedCount: 0 };
            existing.count++;
            toolUseCounts.set(toolName, existing);
            const input = block.input as Record<string, unknown> | undefined;

            if (toolName === "Read" && input?.file_path) {
              filesRead.add(input.file_path as string);
            } else if (toolName === "Edit" && input?.file_path) {
              filesEdited.add(input.file_path as string);
            } else if (toolName === "Write" && input?.file_path) {
              filesWritten.add(input.file_path as string);
            } else if (toolName === "Bash" && input?.command) {
              const cmd = (input.command as string).slice(0, 200);
              commandsRun.push(cmd);
              const normCmd = cmd.replace(/\s+/g, " ").trim().slice(0, 80);
              commandCounts.set(normCmd, (commandCounts.get(normCmd) ?? 0) + 1);
            } else if (toolName === "TaskCreate" && input?.subject) {
              taskCounter++;
              const id = String(taskCounter);
              tasksMap.set(id, {
                id,
                subject: input.subject as string,
                description: input.description as string | undefined,
                status: "pending",
              });
            } else if (toolName === "TaskUpdate" && input?.taskId) {
              const id = String(input.taskId);
              const existing = tasksMap.get(id);
              if (existing) {
                if (input.status) existing.status = input.status as TaskSummaryItem["status"];
                if (input.subject) existing.subject = input.subject as string;
                if (input.description) existing.description = input.description as string;
              }
            }
          }
        }
        if (content.length === 0) {
          const text = extractCopilotAssistantText(obj);
          if (text) {
            if (keyExcerpts.length < 10) {
              keyExcerpts.push(text.length > 300 ? text.slice(0, 300) + "..." : text);
            }
            agentSummaryParts.push(text);
            model = getString(obj, ["model", "modelId", "model_id"]) || model;
          }
        }
        continue;
      }

      if (type === "user") {
        const message = obj.message as Record<string, unknown> | undefined;
        const content = (message?.content as Array<Record<string, unknown>>) || [];

        for (const block of content) {
          if (block.type === "tool_result") {
            const toolUseId = (block.tool_use_id as string) || "";
            const toolName = toolUseId ? (toolNameMap.get(toolUseId) || "unknown") : "unknown";
            const rawContent = block.content;
            const output = typeof rawContent === "string"
              ? rawContent
              : JSON.stringify(rawContent);
            if (block.is_error as boolean) {
              if (errors.length < 10) {
                errors.push(`${toolName}: ${output.length > 200 ? output.slice(0, 200) + "..." : output}`);
              }
              const entry = toolUseCounts.get(toolName);
              if (entry) entry.failedCount++;
            } else if (toolName === "Agent" && output) {
              agentSummaryParts.push(output);
            }
          }
        }
        continue;
      }

      if (type === "result") {
        const resultText = (obj.result as string) || "";
        if (resultText) agentSummaryParts.push(resultText);
        const usage = asRecord(obj.usage) || asRecord(obj.stats) || obj;
        model = getString(obj, ["model", "modelId", "model_id"]) || getString(usage, ["model", "modelId", "model_id"]) || model;
        continue;
      }

      const copilotAssistantText = extractCopilotAssistantText(obj);
      if (copilotAssistantText) {
        model = getString(obj, ["model", "modelId", "model_id"]) || model;
        if (keyExcerpts.length < 10) {
          keyExcerpts.push(copilotAssistantText.length > 300 ? copilotAssistantText.slice(0, 300) + "..." : copilotAssistantText);
        }
        agentSummaryParts.push(copilotAssistantText);
        continue;
      }

      if (type === "rate_limit_event") {
        const rli = obj.rate_limit_info as Record<string, unknown> | undefined;
        if (rli) {
          rateLimits.push({
            rateLimitType: (rli.rateLimitType as string) || "unknown",
            status: (rli.status as string) || "unknown",
            resetsAt: rli.resetsAt as number | undefined,
            overageStatus: rli.overageStatus as string | undefined,
          });
        }
        continue;
      }
    }
  }

  const actions: Array<{ type: string; files?: string[]; commands?: string[] }> = [];
  if (filesRead.size > 0) actions.push({ type: "read", files: [...filesRead] });
  if (filesEdited.size > 0) actions.push({ type: "edit", files: [...filesEdited] });
  if (filesWritten.size > 0) actions.push({ type: "write", files: [...filesWritten] });
  if (commandsRun.length > 0) actions.push({ type: "command", commands: commandsRun });

  const parts: string[] = [];
  if (initFound) parts.push(`Agent session using ${model}`);
  if (filesRead.size > 0) parts.push(`read ${filesRead.size} file${filesRead.size !== 1 ? "s" : ""}`);
  if (filesEdited.size > 0) parts.push(`edited ${filesEdited.size} file${filesEdited.size !== 1 ? "s" : ""}`);
  if (filesWritten.size > 0) parts.push(`wrote ${filesWritten.size} file${filesWritten.size !== 1 ? "s" : ""}`);
  if (commandsRun.length > 0) parts.push(`ran ${commandsRun.length} command${commandsRun.length !== 1 ? "s" : ""}`);
  const overview = parts.length > 0 ? parts.join(", ") : "No activity recorded";

  const agentSummary = agentSummaryParts.length > 0 ? agentSummaryParts.join("\n\n---\n\n") : null;

  const toolUsePatterns: ToolUsePattern[] = [...toolUseCounts.entries()]
    .map(([tool, { count, failedCount }]) => ({ tool, count, failedCount }))
    .sort((a, b) => b.count - a.count);

  const repeatedCommands: RepeatedCommand[] = [...commandCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count);

  return {
    overview,
    agentSummary,
    actions,
    keyExcerpts,
    errors,
    filesRead: [...filesRead],
    filesEdited: [...filesEdited],
    filesWritten: [...filesWritten],
    commandsRun,
    model,
    tasks: [...tasksMap.values()],
    rateLimits,
    toolUsePatterns,
    repeatedCommands,
  };
}
