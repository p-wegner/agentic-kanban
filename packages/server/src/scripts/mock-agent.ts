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

// Line 2: assistant message with text content
const assistantMsg = {
  type: "assistant",
  message: {
    id: "msg_mock_" + Math.random().toString(36).slice(2, 10),
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Mock agent completed the task successfully. No files were modified.",
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
  is_error: false,
  duration_ms: durationMs,
  duration_api_ms: durationMs,
  num_turns: 1,
  result:
    "Mock agent completed the task successfully. No files were modified.",
  session_id: initMsg.session_id,
  usage: { input_tokens: 150, output_tokens: 42 },
};

// Write each line as NDJSON with a small delay between them
process.stdout.write(JSON.stringify(initMsg) + "\n");

setTimeout(() => {
  process.stdout.write(JSON.stringify(assistantMsg) + "\n");

  setTimeout(() => {
    // Recalculate duration to include delays
    resultMsg.duration_ms = Date.now() - startTime;
    resultMsg.duration_api_ms = resultMsg.duration_ms;
    process.stdout.write(JSON.stringify(resultMsg) + "\n");
    process.exit(0);
  }, 200);
}, 200);
