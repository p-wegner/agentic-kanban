import { describe, expect, it } from "vitest";
import {
  CopilotOutputParser,
  createAgentOutputParser,
  getOutputFormatForAgent,
  getOutputFormatForProvider,
  RawOutputParser,
} from "./agent-output-parser.js";
import { PiOutputParser } from "./pi-output-parser.js";

describe("agent output parser factory", () => {
  it("creates the Claude stream-json parser by default", () => {
    const parser = createAgentOutputParser();

    expect(parser.format).toBe("claude-stream-json");
    expect(parser.label).toBe("stream-json");
  });

  it("creates a raw parser for unstructured agent output", () => {
    const parser = createAgentOutputParser("raw");

    expect(parser).toBeInstanceOf(RawOutputParser);
    expect(parser.feed("hello\n")).toEqual([{ kind: "raw", text: "hello" }]);
  });

  it("buffers partial raw output until a newline or flush", () => {
    const parser = new RawOutputParser();

    expect(parser.feed("hel")).toEqual([]);
    expect(parser.feed("lo\nnext")).toEqual([{ kind: "raw", text: "hello" }]);
    expect(parser.flush()).toEqual([{ kind: "raw", text: "next" }]);
  });

  it("creates the Copilot JSONL parser", () => {
    const parser = createAgentOutputParser("copilot-jsonl");

    expect(parser).toBeInstanceOf(CopilotOutputParser);
    expect(parser.format).toBe("copilot-jsonl");
    expect(parser.label).toBe("copilot-jsonl");
  });

  it("creates the Pi JSONL parser", () => {
    const parser = createAgentOutputParser("pi-jsonl");

    expect(parser).toBeInstanceOf(PiOutputParser);
    expect(parser.format).toBe("pi-jsonl");
    expect(parser.label).toBe("pi-jsonl");
  });
});

describe("PiOutputParser", () => {
  it("parses session and assistant text_delta events from Pi JSONL", () => {
    const parser = new PiOutputParser();
    const output = [
      "{\"type\":\"session\",\"version\":3,\"id\":\"019ec69d-bed7-75ad-9b25-2b19161227d5\",\"timestamp\":\"2026-06-14T14:51:27.320Z\",\"cwd\":\"C:\\\\Users\\\\pwegner\\\\AppData\\\\Local\\\\Temp\\\\ak-pi-cli-findings\\\\work\"}",
      "{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"contentIndex\":0,\"delta\":\"one-shot-ok\",\"partial\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"one-shot-ok\"}],\"api\":\"ak-faux-api\",\"provider\":\"ak-faux\",\"model\":\"ak-faux-1\",\"usage\":{\"input\":1329,\"output\":3,\"cacheRead\":0,\"cacheWrite\":1329,\"totalTokens\":2661,\"cost\":{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"total\":0}},\"stopReason\":\"stop\",\"timestamp\":1781448687453}},\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"one-shot-ok\"}],\"api\":\"ak-faux-api\",\"provider\":\"ak-faux\",\"model\":\"ak-faux-1\",\"usage\":{\"input\":1329,\"output\":3,\"cacheRead\":0,\"cacheWrite\":1329,\"totalTokens\":2661,\"cost\":{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"total\":0}},\"stopReason\":\"stop\",\"timestamp\":1781448687453}}",
      "{\"type\":\"agent_end\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"one-shot schema capture\"}],\"timestamp\":1781448687447},{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"one-shot-ok\"}],\"api\":\"ak-faux-api\",\"provider\":\"ak-faux\",\"model\":\"ak-faux-1\",\"usage\":{\"input\":1329,\"output\":3,\"cacheRead\":0,\"cacheWrite\":1329,\"totalTokens\":2661,\"cost\":{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"total\":0}},\"stopReason\":\"stop\",\"timestamp\":1781448687453}]}",
    ].join("\n") + "\n";

    expect(parser.feed(output)).toEqual([
      {
        kind: "init",
        model: "pi",
        sessionId: "019ec69d-bed7-75ad-9b25-2b19161227d5",
        cwd: "C:\\Users\\pwegner\\AppData\\Local\\Temp\\ak-pi-cli-findings\\work",
        tools: [],
        mcpServers: [],
        permissionMode: "",
      },
      { kind: "assistant", text: "one-shot-ok", model: "ak-faux-1" },
      {
        kind: "result",
        success: true,
        durationMs: 0,
        result: "",
        totalCostUsd: 0,
        inputTokens: 1329,
        outputTokens: 3,
        model: "ak-faux-1",
      },
    ]);
  });

  it("parses Pi tool execution start and end events", () => {
    const parser = new PiOutputParser();
    const output = [
      "{\"type\":\"tool_execution_start\",\"toolCallId\":\"tool-call-read-sample\",\"toolName\":\"read\",\"args\":{\"path\":\"sample.txt\"}}",
      "{\"type\":\"tool_execution_end\",\"toolCallId\":\"tool-call-read-sample\",\"toolName\":\"read\",\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"pi scratch sample file\\r\\n\"}]},\"isError\":false}",
      "{\"type\":\"tool_execution_start\",\"toolCallId\":\"tool-call-write-blocked\",\"toolName\":\"write\",\"args\":{\"path\":\"blocked.txt\",\"content\":\"blocked\"}}",
      "{\"type\":\"tool_execution_end\",\"toolCallId\":\"tool-call-write-blocked\",\"toolName\":\"write\",\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"blocked by ak faux extension\"}],\"details\":{}},\"isError\":true}",
    ].join("\n") + "\n";

    expect(parser.feed(output)).toEqual([
      {
        kind: "tool_use",
        id: "tool-call-read-sample",
        name: "read",
        input: "{\"path\":\"sample.txt\"}",
        inputParsed: { path: "sample.txt" },
      },
      {
        kind: "tool_result",
        toolName: "read",
        toolUseId: "tool-call-read-sample",
        output: "pi scratch sample file\r\n",
        isError: false,
      },
      {
        kind: "tool_use",
        id: "tool-call-write-blocked",
        name: "write",
        input: "{\"path\":\"blocked.txt\",\"content\":\"blocked\"}",
        inputParsed: { path: "blocked.txt", content: "blocked" },
      },
      {
        kind: "tool_result",
        toolName: "write",
        toolUseId: "tool-call-write-blocked",
        output: "blocked by ak faux extension",
        isError: true,
      },
    ]);
  });

  it("parses Pi assistant error messages as failed result events", () => {
    const parser = new PiOutputParser();
    const output = "{\"type\":\"message_start\",\"message\":{\"role\":\"assistant\",\"content\":[],\"api\":\"ak-faux-api\",\"provider\":\"ak-faux\",\"model\":\"ak-faux-1\",\"usage\":{\"input\":729,\"output\":0,\"cacheRead\":620,\"cacheWrite\":730,\"totalTokens\":2079,\"cost\":{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"total\":0}},\"stopReason\":\"error\",\"errorMessage\":\"No more faux responses queued\",\"timestamp\":1781448948042}}\n";

    expect(parser.feed(output)).toEqual([
      {
        kind: "result",
        success: false,
        durationMs: 0,
        result: "No more faux responses queued",
        totalCostUsd: 0,
        inputTokens: 729,
        outputTokens: 0,
        model: "ak-faux-1",
      },
    ]);
  });

  it("buffers Pi JSONL partial lines across feed calls", () => {
    const parser = new PiOutputParser();
    const line = "{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"contentIndex\":0,\"delta\":\"resume-ok\",\"partial\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"resume-ok\"}],\"api\":\"ak-faux-api\",\"provider\":\"ak-faux\",\"model\":\"ak-faux-1\",\"usage\":{\"input\":1341,\"output\":3,\"cacheRead\":0,\"cacheWrite\":1341,\"totalTokens\":2685,\"cost\":{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"total\":0}},\"stopReason\":\"stop\",\"timestamp\":1781448703091}},\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"resume-ok\"}],\"api\":\"ak-faux-api\",\"provider\":\"ak-faux\",\"model\":\"ak-faux-1\",\"usage\":{\"input\":1341,\"output\":3,\"cacheRead\":0,\"cacheWrite\":1341,\"totalTokens\":2685,\"cost\":{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"total\":0}},\"stopReason\":\"stop\",\"timestamp\":1781448703091}}";
    const splitAt = 118;

    expect(parser.feed(line.slice(0, splitAt))).toEqual([]);
    expect(parser.feed(line.slice(splitAt) + "\n")).toEqual([
      { kind: "assistant", text: "resume-ok", model: "ak-faux-1" },
    ]);
  });

  it("flushes a buffered Pi line", () => {
    const parser = new PiOutputParser();

    expect(parser.feed("{\"type\":\"session\",\"version\":3")).toEqual([]);
    expect(parser.flush()).toEqual([{ kind: "raw", text: "{\"type\":\"session\",\"version\":3" }]);
  });
});

describe("CopilotOutputParser", () => {
  it("parses session, assistant, tool, and stats events", () => {
    const parser = new CopilotOutputParser();
    const output = [
      JSON.stringify({ type: "session.started", session_id: "copilot-123", model: "gpt-5.2", cwd: "/repo" }),
      JSON.stringify({ type: "assistant_message", text: "I will inspect the parser." }),
      JSON.stringify({ type: "tool_call.started", id: "tool-1", name: "bash", input: { command: "pnpm test" } }),
      JSON.stringify({ type: "tool_call.completed", id: "tool-1", result: "Tests passed", status: "completed" }),
      JSON.stringify({ type: "stats", usage: { input_tokens: 12, output_tokens: 34 }, duration_ms: 1234, model: "gpt-5.2" }),
    ].join("\n") + "\n";

    expect(parser.feed(output)).toEqual([
      {
        kind: "init",
        model: "gpt-5.2",
        sessionId: "copilot-123",
        cwd: "/repo",
        tools: [],
        mcpServers: [],
        permissionMode: "",
      },
      { kind: "assistant", text: "I will inspect the parser.", model: "" },
      {
        kind: "tool_use",
        id: "tool-1",
        name: "bash",
        input: JSON.stringify({ command: "pnpm test" }),
        inputParsed: { command: "pnpm test" },
      },
      {
        kind: "tool_result",
        toolName: "bash",
        toolUseId: "tool-1",
        output: "Tests passed",
        isError: false,
      },
      {
        kind: "result",
        success: true,
        durationMs: 1234,
        result: "",
        totalCostUsd: 0,
        inputTokens: 12,
        outputTokens: 34,
        model: "gpt-5.2",
      },
    ]);
  });

  it("falls back to raw output for invalid or unrecognized lines", () => {
    const parser = new CopilotOutputParser();

    expect(parser.feed("plain text\n")).toEqual([{ kind: "raw", text: "plain text" }]);
    expect(parser.feed(JSON.stringify({ type: "progress", message: "Working" }) + "\n")).toEqual([
      { kind: "raw", text: "Working" },
    ]);
  });

  it("parses Copilot CLI nested JSONL events from a real workspace stream", () => {
    const parser = new CopilotOutputParser();
    const output = [
      JSON.stringify({ type: "session.warning", data: { message: "policy warning" }, id: "event-1" }),
      JSON.stringify({ type: "assistant.reasoning", data: { content: "I will inspect the E2E setup." } }),
      JSON.stringify({
        type: "assistant.message",
        data: {
          messageId: "msg-1",
          model: "claude-sonnet-4.6",
          content: "I found the isolated test project helper.",
        },
      }),
      JSON.stringify({
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-read",
          toolName: "view",
          arguments: { path: "packages/e2e/global-setup.ts" },
        },
      }),
      JSON.stringify({
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-read",
          success: true,
          result: { content: "1. import { request } from \"@playwright/test\";" },
        },
      }),
      JSON.stringify({
        type: "result",
        sessionId: "copilot-session-1",
        exitCode: 0,
        usage: { inputTokens: 10, outputTokens: 5, sessionDurationMs: 123 },
      }),
    ].join("\n") + "\n";

    expect(parser.feed(output)).toEqual([
      { kind: "thinking", text: "I will inspect the E2E setup." },
      { kind: "assistant", text: "I found the isolated test project helper.", model: "claude-sonnet-4.6" },
      {
        kind: "tool_use",
        id: "tool-read",
        name: "view",
        input: JSON.stringify({ path: "packages/e2e/global-setup.ts" }),
        inputParsed: { path: "packages/e2e/global-setup.ts" },
      },
      {
        kind: "tool_result",
        toolName: "view",
        toolUseId: "tool-read",
        output: "1. import { request } from \"@playwright/test\";",
        isError: false,
      },
      {
        kind: "result",
        success: true,
        durationMs: 123,
        result: "",
        totalCostUsd: 0,
        inputTokens: 10,
        outputTokens: 5,
        model: "",
      },
    ]);
  });

  it("extracts cwd from nested context in session.start", () => {
    const parser = new CopilotOutputParser();
    const output = JSON.stringify({
      type: "session.start",
      data: {
        sessionId: "sess-1",
        copilotVersion: "1.0.54",
        startTime: "2026-01-01T00:00:00Z",
        context: { cwd: "C:\\repo\\worktree", branch: "feature/test", gitRoot: "C:\\repo" },
      },
    }) + "\n";

    const events = parser.feed(output);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("init");
    if (events[0].kind === "init") {
      expect(events[0].cwd).toBe("C:\\repo\\worktree");
      expect(events[0].sessionId).toBe("sess-1");
    }
  });

  it("handles session.model_change by tracking model and emitting nothing", () => {
    const parser = new CopilotOutputParser();
    const output = [
      JSON.stringify({ type: "session.start", data: { sessionId: "sess-1", context: { cwd: "/repo" } } }),
      JSON.stringify({ type: "session.model_change", data: { newModel: "claude-sonnet-4.6", reasoningEffort: null } }),
      JSON.stringify({ type: "assistant.message", data: { content: "Hello!", model: "" } }),
    ].join("\n") + "\n";

    const events = parser.feed(output);
    const assistantEvent = events.find(e => e.kind === "assistant");
    expect(assistantEvent).toBeDefined();
    if (assistantEvent?.kind === "assistant") {
      // model should have been updated from session.model_change
      expect(assistantEvent.model).toBe("claude-sonnet-4.6");
    }
    // model_change itself emits no event
    expect(events.filter(e => e.kind === "raw").length).toBe(0);
  });

  it("generates result event from session.shutdown", () => {
    const parser = new CopilotOutputParser();
    const output = JSON.stringify({
      type: "session.shutdown",
      data: {
        shutdownType: "routine",
        totalApiDurationMs: 12000,
        codeChanges: {
          linesAdded: 50,
          linesRemoved: 10,
          filesModified: ["packages/client/src/App.tsx", "packages/server/src/index.ts"],
        },
      },
    }) + "\n";

    const events = parser.feed(output);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("result");
    if (events[0].kind === "result") {
      expect(events[0].success).toBe(true);
      expect(events[0].durationMs).toBe(12000);
      expect(events[0].result).toContain("+50/-10 lines in 2 files");
    }
  });

  it("shows user.message as a notification with key 'user'", () => {
    const parser = new CopilotOutputParser();
    const output = JSON.stringify({
      type: "user.message",
      data: { content: "Fix the broken tests\nand also update docs", transformedContent: "<system>...</system>" },
    }) + "\n";

    const events = parser.feed(output);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("notification");
    if (events[0].kind === "notification") {
      expect(events[0].key).toBe("user");
      expect(events[0].text).toBe("Fix the broken tests");
    }
  });

  it("parses JSON string arguments in tool.execution_start", () => {
    const parser = new CopilotOutputParser();
    const args = JSON.stringify({ command: "pnpm test", description: "Run tests" });
    const output = JSON.stringify({
      type: "tool.execution_start",
      data: {
        toolCallId: "tool-1",
        toolName: "powershell",
        arguments: args,
      },
    }) + "\n";

    const events = parser.feed(output);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("tool_use");
    if (events[0].kind === "tool_use") {
      expect(events[0].inputParsed).toEqual({ command: "pnpm test", description: "Run tests" });
    }
  });

  it("registers toolCallId from assistant.message toolRequests for later name resolution", () => {
    const parser = new CopilotOutputParser();
    const output = [
      JSON.stringify({
        type: "assistant.message",
        data: {
          model: "claude-sonnet-4.6",
          content: "",
          toolRequests: [{ toolCallId: "call-1", name: "grep", arguments: { pattern: "TODO" } }],
        },
      }),
      JSON.stringify({
        type: "tool.execution_complete",
        data: { toolCallId: "call-1", success: true, result: { content: "found 3 matches" } },
      }),
    ].join("\n") + "\n";

    const events = parser.feed(output);
    // tool_result should resolve tool name from toolRequests registration
    const resultEvent = events.find(e => e.kind === "tool_result");
    expect(resultEvent).toBeDefined();
    if (resultEvent?.kind === "tool_result") {
      expect(resultEvent.toolName).toBe("grep");
      expect(resultEvent.output).toBe("found 3 matches");
    }
  });

  it("emits thinking event from assistant.message reasoningText", () => {
    const parser = new CopilotOutputParser();
    const output = [
      JSON.stringify({
        type: "assistant.message",
        data: {
          model: "claude-sonnet-4.6",
          content: "",
          reasoningText: "Let me explore the codebase to understand the structure.",
          toolRequests: [{ toolCallId: "call-2", name: "glob", arguments: { pattern: "**/*.ts" } }],
        },
      }),
    ].join("\n") + "\n";

    const events = parser.feed(output);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("thinking");
    if (events[0].kind === "thinking") {
      expect(events[0].text).toBe("Let me explore the codebase to understand the structure.");
    }
  });

  it("emits both thinking and assistant events when assistant.message has both", () => {
    const parser = new CopilotOutputParser();
    const output = JSON.stringify({
      type: "assistant.message",
      data: {
        model: "claude-sonnet-4.6",
        content: "I found the issue — the path uses backslashes.",
        reasoningText: "The code looks correct. Let me think about edge cases.",
      },
    }) + "\n";

    const events = parser.feed(output);
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("thinking");
    expect(events[1].kind).toBe("assistant");
    if (events[0].kind === "thinking") {
      expect(events[0].text).toBe("The code looks correct. Let me think about edge cases.");
    }
    if (events[1].kind === "assistant") {
      expect(events[1].text).toBe("I found the issue — the path uses backslashes.");
      expect(events[1].model).toBe("claude-sonnet-4.6");
    }
  });
});


describe("getOutputFormatForAgent", () => {
  it("returns claude-stream-json for undefined (default agent)", () => {
    expect(getOutputFormatForAgent()).toBe("claude-stream-json");
  });

  it("returns claude-stream-json for empty string", () => {
    expect(getOutputFormatForAgent("")).toBe("claude-stream-json");
  });

  it("returns claude-stream-json for claude command", () => {
    expect(getOutputFormatForAgent("claude")).toBe("claude-stream-json");
    expect(getOutputFormatForAgent("claude.exe")).toBe("claude-stream-json");
  });

  it("returns claude-stream-json for full claude path", () => {
    expect(getOutputFormatForAgent("C:\\Users\\test\\.claude\\local\\claude.exe")).toBe("claude-stream-json");
    expect(getOutputFormatForAgent("/usr/local/bin/claude")).toBe("claude-stream-json");
  });

  it("returns claude-stream-json for mock-agent", () => {
    expect(getOutputFormatForAgent("node mock-agent.ts")).toBe("claude-stream-json");
    expect(getOutputFormatForAgent("/some/path/mock-agent-foo")).toBe("claude-stream-json");
  });

  it("returns codex-jsonl for codex command", () => {
    expect(getOutputFormatForAgent("codex")).toBe("codex-jsonl");
    expect(getOutputFormatForAgent("codex.cmd")).toBe("codex-jsonl");
    expect(getOutputFormatForAgent("C:\\Users\\test\\scoop\\codex.cmd")).toBe("codex-jsonl");
  });

  it("returns copilot-jsonl for copilot command", () => {
    expect(getOutputFormatForAgent("copilot")).toBe("copilot-jsonl");
    expect(getOutputFormatForAgent("copilot.cmd")).toBe("copilot-jsonl");
    expect(getOutputFormatForAgent("C:\\Users\\test\\AppData\\Local\\GitHub\\copilot.exe")).toBe("copilot-jsonl");
  });

  it("returns pi-jsonl for pi command", () => {
    expect(getOutputFormatForAgent("pi")).toBe("pi-jsonl");
    expect(getOutputFormatForAgent("pi.cmd")).toBe("pi-jsonl");
    expect(getOutputFormatForAgent("C:\\Users\\test\\AppData\\Roaming\\npm\\pi.cmd")).toBe("pi-jsonl");
  });

  it("returns raw for other agent commands", () => {
    expect(getOutputFormatForAgent("aider")).toBe("raw");
    expect(getOutputFormatForAgent("custom-agent")).toBe("raw");
    expect(getOutputFormatForAgent("/usr/bin/python3 agent.py")).toBe("raw");
  });
});

describe("getOutputFormatForProvider", () => {
  it("returns claude-stream-json for undefined/null (default)", () => {
    expect(getOutputFormatForProvider()).toBe("claude-stream-json");
    expect(getOutputFormatForProvider(null)).toBe("claude-stream-json");
    expect(getOutputFormatForProvider(undefined)).toBe("claude-stream-json");
  });

  it("returns claude-stream-json for claude provider", () => {
    expect(getOutputFormatForProvider("claude")).toBe("claude-stream-json");
  });

  it("returns codex-jsonl for codex provider", () => {
    expect(getOutputFormatForProvider("codex")).toBe("codex-jsonl");
  });

  it("returns copilot-jsonl for copilot provider", () => {
    expect(getOutputFormatForProvider("copilot")).toBe("copilot-jsonl");
  });

  it("returns pi-jsonl for pi provider", () => {
    expect(getOutputFormatForProvider("pi")).toBe("pi-jsonl");
  });

  it("returns raw for unknown providers", () => {
    expect(getOutputFormatForProvider("aider")).toBe("raw");
    expect(getOutputFormatForProvider("custom")).toBe("raw");
  });
});
