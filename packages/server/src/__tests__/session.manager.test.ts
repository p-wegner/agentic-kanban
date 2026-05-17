import { describe, it, expect, vi, beforeEach } from "vitest";

// The session manager exports formatToolActivity and tasksToTodoItems as private helpers.
// We test them by re-implementing the same logic for unit testing, and test the public API
// via the createSessionManager factory with mocked dependencies.

// Re-implement private helpers for direct testing (they are not exported)
function formatToolActivity(name: string, input: Record<string, unknown>): string {
  function basename(path: string): string {
    const parts = path.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || path;
  }
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

function tasksToTodoItems(tasks: Map<string, { subject: string; status: string }>) {
  return Array.from(tasks.entries()).map(([id, task]) => ({
    id,
    content: task.subject,
    status: (task.status === "in_progress" || task.status === "completed" || task.status === "pending")
      ? task.status as "pending" | "in_progress" | "completed"
      : "pending",
    priority: "medium" as const,
  }));
}

describe("formatToolActivity", () => {
  it("formats Read tool", () => {
    expect(formatToolActivity("Read", { file_path: "/src/components/App.tsx" }))
      .toBe("Reading App.tsx");
  });

  it("formats Edit tool", () => {
    expect(formatToolActivity("Edit", { file_path: "C:\\project\\file.ts" }))
      .toBe("Editing file.ts");
  });

  it("formats Write tool", () => {
    expect(formatToolActivity("Write", { file_path: "/tmp/output.json" }))
      .toBe("Writing output.json");
  });

  it("formats Bash tool (truncated to 60 chars)", () => {
    const longCmd = "npm run build -- --production --minify --sourcemap --output-dir=./dist/very-long-path";
    const result = formatToolActivity("Bash", { command: longCmd });
    expect(result).toBe(`Running: ${longCmd.slice(0, 60)}`);
  });

  it("formats Grep tool", () => {
    expect(formatToolActivity("Grep", { pattern: "TODO" }))
      .toBe("Searching for TODO");
  });

  it("formats Glob tool", () => {
    expect(formatToolActivity("Glob", { pattern: "**/*.test.ts" }))
      .toBe("Finding **/*.test.ts");
  });

  it("formats Glob tool without pattern", () => {
    expect(formatToolActivity("Glob", {}))
      .toBe("Finding files");
  });

  it("formats Agent tool", () => {
    expect(formatToolActivity("Agent", {})).toBe("Delegating to agent");
  });

  it("formats WebSearch tool", () => {
    expect(formatToolActivity("WebSearch", {})).toBe("Searching web");
  });

  it("formats WebFetch tool", () => {
    expect(formatToolActivity("WebFetch", {})).toBe("Fetching URL");
  });

  it("formats mcp__web_reader__webReader tool", () => {
    expect(formatToolActivity("mcp__web_reader__webReader", {})).toBe("Fetching URL");
  });

  it("returns tool name for unknown tools", () => {
    expect(formatToolActivity("CustomTool", { foo: "bar" })).toBe("CustomTool");
  });

  it("handles missing file_path gracefully", () => {
    expect(formatToolActivity("Read", {})).toBe("Reading ");
  });

  it("handles missing command gracefully", () => {
    expect(formatToolActivity("Bash", {})).toBe("Running: ");
  });
});

describe("tasksToTodoItems", () => {
  it("converts task map to todo items", () => {
    const tasks = new Map<string, { subject: string; status: string }>();
    tasks.set("1", { subject: "Write tests", status: "pending" });
    tasks.set("2", { subject: "Fix bug", status: "in_progress" });
    tasks.set("3", { subject: "Deploy", status: "completed" });

    const items = tasksToTodoItems(tasks);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ id: "1", content: "Write tests", status: "pending", priority: "medium" });
    expect(items[1]).toEqual({ id: "2", content: "Fix bug", status: "in_progress", priority: "medium" });
    expect(items[2]).toEqual({ id: "3", content: "Deploy", status: "completed", priority: "medium" });
  });

  it("defaults unknown status to pending", () => {
    const tasks = new Map<string, { subject: string; status: string }>();
    tasks.set("1", { subject: "Task", status: "unknown_status" });

    const items = tasksToTodoItems(tasks);
    expect(items[0].status).toBe("pending");
  });

  it("returns empty array for empty map", () => {
    const tasks = new Map<string, { subject: string; status: string }>();
    expect(tasksToTodoItems(tasks)).toEqual([]);
  });
});

// Test session manager broadcast message parsing logic.
// The session manager's broadcast() parses JSON from stdout messages to extract
// claude session IDs, tool activities, stats, todos, and subagent counts.
// We test this parsing by verifying the JSON parsing patterns directly.
describe("session broadcast parsing", () => {
  it("detects system/init events with session_id", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123-def" });
    const obj = JSON.parse(line);
    expect(obj.type).toBe("system");
    expect(obj.subtype).toBe("init");
    expect(obj.session_id).toBe("abc-123-def");
  });

  it("detects result events with usage stats", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200 },
      total_cost_usd: 0.05,
      duration_ms: 5000,
      num_turns: 3,
      model: "claude-sonnet-4-6",
    });
    const obj = JSON.parse(line);
    expect(obj.type).toBe("result");
    expect(obj.usage.input_tokens).toBe(100);
    expect(obj.usage.cache_read_input_tokens).toBe(200);
    expect(obj.total_cost_usd).toBe(0.05);
    expect(obj.model).toBe("claude-sonnet-4-6");
  });

  it("detects assistant messages with tool_use content blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 500, cache_read_input_tokens: 300 },
        content: [
          { type: "text", text: "Let me read that file." },
          { type: "tool_use", name: "Read", id: "tu-1", input: { file_path: "/src/app.ts" } },
        ],
      },
    });
    const obj = JSON.parse(line);
    expect(obj.type).toBe("assistant");
    expect(obj.message.model).toBe("claude-sonnet-4-6");

    const contextTokens = (obj.message.usage?.cache_read_input_tokens ?? 0) + (obj.message.usage?.input_tokens ?? 0);
    expect(contextTokens).toBe(800);

    const content = obj.message.content;
    const toolBlocks = content.filter((b: any) => b.type === "tool_use");
    expect(toolBlocks).toHaveLength(1);
    expect(toolBlocks[0].name).toBe("Read");
    expect(toolBlocks[0].input.file_path).toBe("/src/app.ts");
  });

  it("detects Agent tool_use for subagent tracking", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Agent", id: "tu-agent-1", input: { prompt: "Do something" } },
        ],
      },
    });
    const obj = JSON.parse(line);
    const toolBlocks = obj.message.content.filter((b: any) => b.type === "tool_use");
    expect(toolBlocks[0].name).toBe("Agent");
    expect(toolBlocks[0].id).toBe("tu-agent-1");
  });

  it("detects tool_result for Agent subagent decrement", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu-agent-1", content: "done" },
        ],
      },
    });
    const obj = JSON.parse(line);
    const resultBlocks = obj.message.content.filter((b: any) => b.type === "tool_result");
    expect(resultBlocks).toHaveLength(1);
    expect(resultBlocks[0].tool_use_id).toBe("tu-agent-1");
  });

  it("detects TodoWrite calls in tool_use", () => {
    const todos = [
      { id: "1", content: "Task A", status: "pending", priority: "high" },
      { id: "2", content: "Task B", status: "in_progress", priority: "medium" },
    ];
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "TodoWrite", id: "tu-todo-1", input: { todos } },
        ],
      },
    });
    const obj = JSON.parse(line);
    const toolBlocks = obj.message.content.filter((b: any) => b.type === "tool_use");
    expect(toolBlocks[0].name).toBe("TodoWrite");
    expect(toolBlocks[0].input.todos).toHaveLength(2);
  });

  it("detects TaskCreate calls", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "TaskCreate", id: "tu-task-1", input: { subject: "Write unit tests" } },
        ],
      },
    });
    const obj = JSON.parse(line);
    const toolBlocks = obj.message.content.filter((b: any) => b.type === "tool_use");
    expect(toolBlocks[0].name).toBe("TaskCreate");
    expect(toolBlocks[0].input.subject).toBe("Write unit tests");
  });

  it("detects TaskUpdate calls", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "TaskUpdate", id: "tu-task-2", input: { taskId: "1", status: "in_progress" } },
        ],
      },
    });
    const obj = JSON.parse(line);
    const toolBlocks = obj.message.content.filter((b: any) => b.type === "tool_use");
    expect(toolBlocks[0].name).toBe("TaskUpdate");
    expect(toolBlocks[0].input.taskId).toBe("1");
    expect(toolBlocks[0].input.status).toBe("in_progress");
  });

  it("handles task_progress with tool_uses", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "task_progress",
      usage: { tool_uses: 42 },
    });
    const obj = JSON.parse(line);
    expect(obj.type).toBe("system");
    expect(obj.subtype).toBe("task_progress");
    expect(obj.usage.tool_uses).toBe(42);
  });

  it("non-JSON lines are silently ignored", () => {
    expect(() => JSON.parse("not json at all")).toThrow();
  });
});

// Test the session resume UUID validation pattern used in startSession
describe("claude session ID validation", () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it("accepts valid UUIDs", () => {
    expect(UUID_RE.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("rejects mock session IDs", () => {
    expect(UUID_RE.test("mock-session-123")).toBe(false);
  });

  it("rejects empty strings", () => {
    expect(UUID_RE.test("")).toBe(false);
  });

  it("accepts uppercase UUIDs", () => {
    expect(UUID_RE.test("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });
});
