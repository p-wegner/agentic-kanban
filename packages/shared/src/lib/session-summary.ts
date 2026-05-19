export interface TaskSummaryItem {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
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

export function parseSessionSummary(
  rows: Array<{ type: string; data: string | null }>,
): SessionSummary {
  const toolNameMap = new Map<string, string>();

  const filesRead = new Set<string>();
  const filesEdited = new Set<string>();
  const filesWritten = new Set<string>();
  const commandsRun: string[] = [];
  const keyExcerpts: string[] = [];
  const errors: string[] = [];
  let model = "";
  let initFound = false;
  let agentSummary: string | null = null;
  let taskCounter = 0;
  const tasksMap = new Map<string, TaskSummaryItem>();

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

      if (type === "system" && obj.subtype === "init") {
        initFound = true;
        model = (obj.model as string) || "unknown";
        continue;
      }

      if (type === "assistant") {
        const message = obj.message as Record<string, unknown> | undefined;
        const content = (message?.content as Array<Record<string, unknown>>) || [];
        const msgModel = (message?.model as string) || "";
        if (msgModel) model = msgModel;

        for (const block of content) {
          if (block.type === "text") {
            const text = (block.text as string) || "";
            if (text && keyExcerpts.length < 10) {
              keyExcerpts.push(text.length > 300 ? text.slice(0, 300) + "..." : text);
            }
          } else if (block.type === "tool_use") {
            const toolUseId = (block.id as string) || "";
            const toolName = (block.name as string) || "unknown";
            if (toolUseId) toolNameMap.set(toolUseId, toolName);
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
        continue;
      }

      if (type === "user") {
        const message = obj.message as Record<string, unknown> | undefined;
        const content = (message?.content as Array<Record<string, unknown>>) || [];

        for (const block of content) {
          if (block.type === "tool_result" && (block.is_error as boolean)) {
            const toolUseId = (block.tool_use_id as string) || "";
            const toolName = toolUseId ? (toolNameMap.get(toolUseId) || "unknown") : "unknown";
            const rawContent = block.content;
            const output = typeof rawContent === "string"
              ? rawContent
              : JSON.stringify(rawContent);
            if (errors.length < 10) {
              errors.push(`${toolName}: ${output.length > 200 ? output.slice(0, 200) + "..." : output}`);
            }
          }
        }
        continue;
      }

      if (type === "result") {
        const resultText = (obj.result as string) || "";
        if (resultText) agentSummary = resultText;
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
  };
}
