export function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

export function formatToolActivity(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Read":
      return `Reading ${basename(input.file_path as string || "")}`;
    case "Edit":
      return `Editing ${basename(input.file_path as string || "")}`;
    case "Write":
      return `Writing ${basename(input.file_path as string || "")}`;
    case "Bash": {
      const cmd = (input.command as string || "").slice(0, 60);
      return `Running: ${cmd}`;
    }
    case "Grep":
      return `Searching for ${input.pattern || ""}`;
    case "Glob":
      return `Finding ${input.pattern || "files"}`;
    case "Agent":
      return `Delegating to agent`;
    case "WebSearch":
      return `Searching web`;
    case "WebFetch":
    case "mcp__web_reader__webReader":
      return `Fetching URL`;
    default:
      return name;
  }
}

import type { TodoItem } from "../board-events.js";

export function tasksToTodoItems(tasks: Map<string, { subject: string; status: string }>): TodoItem[] {
  return Array.from(tasks.entries()).map(([id, task]) => ({
    id,
    content: task.subject,
    status: (task.status === "in_progress" || task.status === "completed" || task.status === "pending")
      ? task.status as "pending" | "in_progress" | "completed"
      : "pending",
    priority: "medium" as const,
  }));
}
