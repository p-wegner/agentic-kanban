import { describe, expect, it } from "vitest";

import {
  createAgentStreamParseContext,
  parseAgentStreamLine,
} from "../src/lib/agent-stream-parser.js";

/**
 * Characterization tests for the per-provider stream parsers (claude/codex/pi).
 *
 * These parsers carry no behavioral unit tests of their own and have very high
 * cyclomatic complexity (flat per-event-type dispatch). Before decomposing each
 * `parseXEvent` into named per-event handlers, this suite pins the EXACT output
 * for representative events of every branch via inline snapshots, so the
 * refactor is provably behavior-preserving. If a snapshot changes, the refactor
 * altered observable behavior — investigate, don't update blindly.
 */

const parse = (provider: "claude" | "codex" | "pi", obj: unknown) =>
  parseAgentStreamLine(provider, JSON.stringify(obj), createAgentStreamParseContext());

describe("claude parser characterization", () => {
  it("system/init", () => {
    expect(parse("claude", {
      type: "system",
      subtype: "init",
      session_id: "sess-1",
      model: "claude-opus-4",
      cwd: "/repo",
      tools: ["Read", "Bash"],
      mcp_servers: [{ name: "x", status: "ok" }],
      permissionMode: "default",
    })).toMatchInlineSnapshot(`
      {
        "displayEvents": [
          {
            "cwd": "/repo",
            "kind": "init",
            "mcpServers": [
              {
                "name": "x",
                "status": "ok",
              },
            ],
            "model": "claude-opus-4",
            "permissionMode": "default",
            "sessionId": "sess-1",
            "tools": [
              "Read",
              "Bash",
            ],
          },
        ],
        "providerSessionId": "sess-1",
      }
    `);
  });

  it("system/task_started", () => {
    expect(parse("claude", {
      type: "system",
      subtype: "task_started",
      task_id: "t1",
      tool_use_id: "u1",
      description: "do a thing",
      task_type: "general",
    })).toMatchInlineSnapshot(`
      {
        "displayEvents": [
          {
            "description": "do a thing",
            "kind": "task_started",
            "taskId": "t1",
            "taskType": "general",
            "toolUseId": "u1",
          },
        ],
      }
    `);
  });

  it("system/notification", () => {
    expect(parse("claude", {
      type: "system", subtype: "notification", key: "k", text: "hi", priority: "high",
    })).toMatchInlineSnapshot(`
      {
        "displayEvents": [
          {
            "key": "k",
            "kind": "notification",
            "priority": "high",
            "text": "hi",
          },
        ],
      }
    `);
  });

  it("system/status", () => {
    expect(parse("claude", { type: "system", subtype: "status", status: "thinking" })).toMatchInlineSnapshot(`
      {
        "displayEvents": [
          {
            "kind": "raw",
            "text": "[status] thinking",
          },
        ],
      }
    `);
  });

  it("system/task_progress", () => {
    expect(parse("claude", {
      type: "system", subtype: "task_progress", usage: { tool_uses: 3 }, message: "step 2",
    })).toMatchInlineSnapshot(`
      {
        "displayEvents": [
          {
            "kind": "raw",
            "text": "[progress] step 2",
          },
        ],
        "liveStats": {
          "contextTokens": 0,
          "model": "",
          "toolUses": 3,
        },
      }
    `);
  });

  it("assistant with thinking+text+tool_use(TodoWrite)", () => {
    expect(parse("claude", {
      type: "assistant",
      message: {
        model: "claude-opus-4",
        usage: { input_tokens: 100, cache_read_input_tokens: 50 },
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "Hello" },
          { type: "tool_use", id: "tu1", name: "TodoWrite", input: { todos: [{ subject: "a", status: "pending" }] } },
        ],
      },
    })).toMatchInlineSnapshot(`
      {
        "assistantText": "Hello",
        "displayEvents": [
          {
            "kind": "thinking",
            "text": "hmm",
          },
          {
            "kind": "assistant",
            "model": "claude-opus-4",
            "text": "Hello",
          },
          {
            "id": "tu1",
            "input": "{
        "todos": [
          {
            "subject": "a",
            "status": "pending"
          }
        ]
      }",
            "inputParsed": {
              "todos": [
                {
                  "status": "pending",
                  "subject": "a",
                },
              ],
            },
            "kind": "tool_use",
            "name": "TodoWrite",
          },
        ],
        "liveStats": {
          "contextTokens": 150,
          "model": "claude-opus-4",
        },
        "todos": [
          {
            "status": "pending",
            "subject": "a",
          },
        ],
        "toolActivity": {
          "input": {
            "todos": [
              {
                "status": "pending",
                "subject": "a",
              },
            ],
          },
          "name": "TodoWrite",
          "toolUseId": "tu1",
        },
      }
    `);
  });

  it("assistant with Agent tool (subagent delta)", () => {
    expect(parse("claude", {
      type: "assistant",
      message: { model: "m", content: [{ type: "tool_use", id: "x", name: "Agent", input: {} }] },
    })).toMatchInlineSnapshot(`
      {
        "displayEvents": [
          {
            "id": "x",
            "input": "{}",
            "inputParsed": {},
            "kind": "tool_use",
            "name": "Agent",
          },
        ],
        "liveStats": {
          "contextTokens": 0,
          "model": "m",
          "subagentDelta": 1,
        },
        "toolActivity": {
          "input": {},
          "name": "Agent",
          "toolUseId": "x",
        },
      }
    `);
  });

  it("user tool_result string", () => {
    expect(parse("claude", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "output text", is_error: false }] },
    })).toMatchInlineSnapshot(`
      {
        "displayEvents": [
          {
            "isError": false,
            "kind": "tool_result",
            "output": "output text",
            "toolName": "tool_tu1",
            "toolUseId": "tu1",
          },
        ],
        "toolResult": {
          "agentResultText": "output text",
          "toolUseId": "tu1",
        },
      }
    `);
  });

  it("user tool_result array with image", () => {
    expect(parse("claude", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu2", content: [
        { type: "text", text: "see" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
      ] }] },
    })).toMatchInlineSnapshot(`
      {
        "displayEvents": [
          {
            "images": [
              {
                "data": "AAA",
                "mediaType": "image/png",
              },
            ],
            "isError": false,
            "kind": "tool_result",
            "output": "see",
            "toolName": "tool_tu2",
            "toolUseId": "tu2",
          },
        ],
        "toolResult": {
          "agentResultText": "see",
          "images": [
            {
              "data": "AAA",
              "mediaType": "image/png",
            },
          ],
          "toolUseId": "tu2",
        },
      }
    `);
  });

  it("rate_limit_event", () => {
    expect(parse("claude", {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "tokens", resetsAt: 1000, isUsingOverage: false },
    })).toMatchInlineSnapshot(`
      {
        "displayEvents": [
          {
            "isUsingOverage": false,
            "kind": "rate_limit",
            "overageDisabledReason": undefined,
            "overageStatus": undefined,
            "rateLimitType": "tokens",
            "resetsAt": 1000,
            "status": "allowed",
          },
        ],
        "rateLimitInfo": {
          "isUsingOverage": false,
          "overageDisabledReason": undefined,
          "overageStatus": undefined,
          "rateLimitType": "tokens",
          "resetsAt": 1000,
          "status": "allowed",
        },
      }
    `);
  });

  it("result success", () => {
    expect(parse("claude", {
      type: "result",
      subtype: "success",
      duration_ms: 1234,
      total_cost_usd: 0.05,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
      num_turns: 2,
      result: "done",
      model: "claude-opus-4",
    })).toMatchInlineSnapshot(`
      {
        "displayEvents": [
          {
            "durationMs": 1234,
            "inputTokens": 10,
            "kind": "result",
            "model": "claude-opus-4",
            "outputTokens": 5,
            "result": "done",
            "success": true,
            "totalCostUsd": 0.05,
          },
        ],
        "liveStats": {
          "contextTokens": 12,
          "model": "",
        },
        "stats": {
          "agentSummary": "done",
          "durationMs": 1234,
          "inputTokens": 10,
          "model": "claude-opus-4",
          "numTurns": 2,
          "outputTokens": 5,
          "success": true,
          "totalCostUsd": 0.05,
        },
        "turnComplete": true,
      }
    `);
  });
});

describe("codex parser characterization", () => {
  it("thread.started", () => {
    expect(parse("codex", { type: "thread.started", thread_id: "th1" })).toMatchInlineSnapshot(`
      {
        "displayEvents": [
          {
            "cwd": "",
            "kind": "init",
            "mcpServers": [],
            "model": "codex",
            "permissionMode": "",
            "sessionId": "th1",
            "tools": [],
          },
        ],
        "providerSessionId": "th1",
      }
    `);
  });

  it("item agent_message", () => {
    expect(parse("codex", {
      type: "item.completed", item: { type: "agent_message", id: "i1", text: "result text" },
    })).toMatchInlineSnapshot(`
      {
        "assistantText": "result text",
        "displayEvents": [
          {
            "kind": "assistant",
            "model": "codex",
            "text": "result text",
          },
        ],
      }
    `);
  });

  it("item reasoning", () => {
    expect(parse("codex", {
      type: "item.updated", item: { type: "reasoning", id: "i2", text: "thinking..." },
    })).toMatchInlineSnapshot(`
      {
        "displayEvents": [
          {
            "kind": "thinking",
            "text": "thinking...",
          },
        ],
      }
    `);
  });

  it("item command_execution started", () => {
    expect(parse("codex", {
      type: "item.started", item: { type: "command_execution", id: "c1", command: "ls -la", status: "in_progress" },
    })).toMatchInlineSnapshot(`
      {
        "displayEvents": [
          {
            "id": "c1",
            "input": "ls -la",
            "inputParsed": {
              "command": "ls -la",
            },
            "kind": "tool_use",
            "name": "shell",
          },
        ],
        "toolActivity": {
          "input": {
            "command": "ls -la",
          },
          "name": "shell",
          "toolUseId": "c1",
        },
      }
    `);
  });

  it("item command_execution completed", () => {
    expect(parse("codex", {
      type: "item.completed", item: { type: "command_execution", id: "c1", command: "ls", aggregated_output: "file.txt", exit_code: 0, status: "completed" },
    })).toMatchInlineSnapshot(`
      {
        "displayEvents": [
          {
            "isError": false,
            "kind": "tool_result",
            "output": "file.txt",
            "toolName": "shell",
            "toolUseId": "c1",
          },
        ],
        "toolResult": {
          "toolUseId": "c1",
        },
      }
    `);
  });

  it("item mcp_tool_call completed", () => {
    expect(parse("codex", {
      type: "item.completed", item: { type: "mcp_tool_call", id: "m1", name: "search", args: { q: "x" }, result: "found", status: "completed" },
    })).toMatchInlineSnapshot(`
      {
        "displayEvents": [
          {
            "isError": false,
            "kind": "tool_result",
            "output": "found",
            "toolName": "search",
            "toolUseId": "m1",
          },
        ],
        "toolResult": {
          "agentResultText": "found",
          "toolUseId": "m1",
        },
      }
    `);
  });

  it("turn.completed", () => {
    expect(parse("codex", {
      type: "turn.completed",
      usage: { total_token_usage: { input_tokens: 200, output_tokens: 80 }, last_token_usage: { input_tokens: 30 } },
    })).toMatchInlineSnapshot(`
      {
        "displayEvents": [
          {
            "durationMs": 0,
            "inputTokens": 200,
            "kind": "result",
            "model": "codex",
            "outputTokens": 80,
            "result": "",
            "success": true,
            "totalCostUsd": 0,
          },
        ],
        "liveStats": {
          "contextTokens": 30,
          "model": "",
        },
        "stats": {
          "contextTokens": 30,
          "durationMs": 0,
          "inputTokens": 200,
          "model": "codex",
          "numTurns": 1,
          "outputTokens": 80,
          "success": true,
          "totalCostUsd": 0,
        },
        "turnComplete": true,
      }
    `);
  });

  it("turn.failed", () => {
    expect(parse("codex", { type: "turn.failed", error: { message: "boom" } })).toMatchInlineSnapshot(`
      {
        "displayEvents": [
          {
            "durationMs": 0,
            "inputTokens": 0,
            "kind": "result",
            "model": "codex",
            "outputTokens": 0,
            "result": "boom",
            "success": false,
            "totalCostUsd": 0,
          },
        ],
      }
    `);
  });

  it("usage limit detection", () => {
    expect(parse("codex", { type: "error", message: "You've hit your usage limit for GPT-5. Try again at 3pm." })).toMatchInlineSnapshot(`
      {
        "displayEvents": [
          {
            "kind": "raw",
            "text": "You've hit your usage limit for GPT-5. Try again at 3pm.",
          },
        ],
        "rateLimitInfo": {
          "message": "You've hit your usage limit for GPT-5. Try again at 3pm.",
          "rateLimitType": "usage_limit",
          "retryAfter": "3pm",
          "status": "limited",
        },
      }
    `);
  });
});

describe("pi parser characterization", () => {
  it("session", () => {
    expect(parse("pi", { type: "session", id: "p1", cwd: "/r" })).toMatchInlineSnapshot(`
      {
        "displayEvents": [
          {
            "cwd": "/r",
            "kind": "init",
            "mcpServers": [],
            "model": "pi",
            "permissionMode": "",
            "sessionId": "p1",
            "tools": [],
          },
        ],
        "providerSessionId": "p1",
      }
    `);
  });

  it("message_update text_delta", () => {
    expect(parse("pi", {
      type: "message_update", message: { model: "pi-1" }, assistantMessageEvent: { type: "text_delta", delta: "chunk" },
    })).toMatchInlineSnapshot(`
      {
        "assistantText": "chunk",
        "displayEvents": [
          {
            "kind": "assistant",
            "model": "pi-1",
            "text": "chunk",
          },
        ],
        "liveStats": {
          "contextTokens": 0,
          "model": "pi-1",
        },
      }
    `);
  });

  it("message_update toolcall_start", () => {
    expect(parse("pi", {
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", toolCall: { id: "t1", name: "Read", arguments: { file: "x" } } },
    })).toMatchInlineSnapshot(`
      {
        "toolActivity": {
          "input": {
            "file": "x",
          },
          "name": "Read",
          "toolUseId": "t1",
        },
      }
    `);
  });

  it("tool_execution_start", () => {
    expect(parse("pi", { type: "tool_execution_start", toolCallId: "t2", toolName: "Bash", args: { cmd: "ls" } })).toMatchInlineSnapshot(`
      {
        "displayEvents": [
          {
            "id": "t2",
            "input": "{"cmd":"ls"}",
            "inputParsed": {
              "cmd": "ls",
            },
            "kind": "tool_use",
            "name": "Bash",
          },
        ],
        "toolActivity": {
          "input": {
            "cmd": "ls",
          },
          "name": "Bash",
          "toolUseId": "t2",
        },
      }
    `);
  });

  it("tool_execution_end", () => {
    expect(parse("pi", { type: "tool_execution_end", toolCallId: "t2", toolName: "Bash", result: { content: "out" }, isError: false })).toMatchInlineSnapshot(`
      {
        "displayEvents": [
          {
            "isError": false,
            "kind": "tool_result",
            "output": "out",
            "toolName": "Bash",
            "toolUseId": "t2",
          },
        ],
        "toolResult": {
          "agentResultText": "out",
          "toolUseId": "t2",
        },
      }
    `);
  });

  it("turn_end success", () => {
    expect(parse("pi", {
      type: "turn_end",
      message: { model: "pi-1", usage: { input: 10, output: 4, cacheRead: 2, cost: { total: 0.01 } }, content: "all done", stopReason: "stop" },
    })).toMatchInlineSnapshot(`
      {
        "liveStats": {
          "contextTokens": 12,
          "model": "pi-1",
        },
        "stats": {
          "agentSummary": "all done",
          "contextTokens": 12,
          "durationMs": 0,
          "inputTokens": 10,
          "model": "pi-1",
          "numTurns": 1,
          "outputTokens": 4,
          "success": true,
          "totalCostUsd": 0.01,
        },
        "turnComplete": true,
      }
    `);
  });

  it("rate_limit_event", () => {
    expect(parse("pi", { type: "rate_limit_event", rate_limit_info: { status: "limited", rateLimitType: "usage_limit", message: "slow down" } })).toMatchInlineSnapshot(`
      {
        "rateLimitInfo": {
          "isUsingOverage": undefined,
          "message": "slow down",
          "overageDisabledReason": undefined,
          "overageStatus": undefined,
          "rateLimitType": "usage_limit",
          "resetsAt": undefined,
          "retryAfter": undefined,
          "status": "limited",
        },
      }
    `);
  });

  it("error", () => {
    expect(parse("pi", { type: "error", message: "pi failed" })).toMatchInlineSnapshot(`
      {
        "displayEvents": [
          {
            "kind": "raw",
            "text": "pi failed",
          },
        ],
      }
    `);
  });
});
