/**
 * Mock agent that emits stream-json output matching Claude's format.
 *
 * Outputs 3 NDJSON lines:
 *   1. {"type":"system","subtype":"init",...}
 *   2. {"type":"assistant","message":{...}}
 *   3. {"type":"result","subtype":"success",...}
 *
 * Usage:
 *   node --import tsx packages/server/src/scripts/mock-agent.ts [--prompt "ignored"]
 *
 * Or via the built bin:
 *   mock-agent [--prompt "ignored"]
 */

const startTime = Date.now();

// Line 1: system init
const initMsg = {
  type: "system",
  subtype: "init",
  session_id: "mock-session-" + Math.random().toString(36).slice(2, 8),
  tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  model: "mock-claude-opus-4",
  cwd: process.cwd(),
};

// Line 2: assistant message with tool_use content
const toolUseMsg = {
  type: "assistant",
  message: {
    id: "msg_mock_tool_" + Math.random().toString(36).slice(2, 10),
    type: "message",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_mock_" + Math.random().toString(36).slice(2, 10),
        name: "Read",
        input: { file_path: "packages/client/src/components/IssueCard.tsx" },
      },
    ],
    model: "mock-claude-opus-4",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 150, output_tokens: 42 },
  },
};

// Line 3: second tool_use (Edit)
const editMsg = {
  type: "assistant",
  message: {
    id: "msg_mock_edit_" + Math.random().toString(36).slice(2, 10),
    type: "message",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_mock_edit_" + Math.random().toString(36).slice(2, 10),
        name: "Edit",
        input: { file_path: "packages/client/src/components/IssueCard.tsx", old_string: "old", new_string: "new" },
      },
    ],
    model: "mock-claude-opus-4",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 150, output_tokens: 42 },
  },
};

// Line 4: assistant message with text content
const assistantMsg = {
  type: "assistant",
  message: {
    id: "msg_mock_" + Math.random().toString(36).slice(2, 10),
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Mock agent completed the task successfully.",
      },
    ],
    model: "mock-claude-opus-4",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 150, output_tokens: 42 },
  },
};

// Line 3: result
const durationMs = Date.now() - startTime;
const resultMsg = {
  type: "result",
  subtype: "success",
  cost_usd: 0.001,
  total_cost_usd: 0.001,
  is_error: false,
  duration_ms: durationMs,
  duration_api_ms: durationMs,
  num_turns: 1,
  result:
    "Mock agent completed the task successfully. No files were modified.",
  session_id: initMsg.session_id,
  usage: { input_tokens: 150, output_tokens: 42 },
};

// Write each line as NDJSON with delays to simulate real-time activity
process.stdout.write(JSON.stringify(initMsg) + "\n");

setTimeout(() => {
  process.stdout.write(JSON.stringify(toolUseMsg) + "\n");

  setTimeout(() => {
    process.stdout.write(JSON.stringify(editMsg) + "\n");

    setTimeout(() => {
      process.stdout.write(JSON.stringify(assistantMsg) + "\n");

      setTimeout(() => {
        // Recalculate duration to include delays
        resultMsg.duration_ms = Date.now() - startTime;
        resultMsg.duration_api_ms = resultMsg.duration_ms;
        process.stdout.write(JSON.stringify(resultMsg) + "\n");
        process.exit(0);
      }, 500);
    }, 500);
  }, 500);
}, 500);
