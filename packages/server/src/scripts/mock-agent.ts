/**
 * Configurable mock agent that emits stream-json output matching Claude's format.
 *
 * Behavior profiles (via --profile or MOCK_AGENT_PROFILE env var):
 *   standard   - Default: init + tool_use(Read/Edit) + text + result (current behavior)
 *   minimal    - Fast: init + text + result
 *   multi-turn - Stdin-based: first turn + wait for JSONL on stdin + respond per turn
 *   error      - Failure: init + error result, exits with code 1
 *
 * Configuration:
 *   --session-id <uuid>   / MOCK_SESSION_ID     - Deterministic session UUID
 *   --delay-ms <ms>       / MOCK_DELAY_MS        - Delay between events (default: 500)
 *   --profile <name>      / MOCK_AGENT_PROFILE   - Behavior profile (default: standard)
 *   --resume <id>         - Resume a previous session (logged to stderr)
 *
 * Usage:
 *   node --import tsx packages/server/src/scripts/mock-agent.ts [--profile standard] [--delay-ms 500]
 *   mock-agent [--profile minimal] [--delay-ms 100]
 */

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

// --- Config resolution ---

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        result[key] = argv[++i];
      } else {
        result[key] = true;
      }
    }
  }
  return result;
}

const parsedArgs = parseArgs(process.argv);

function getConfig(key: string): string | boolean | undefined {
  const envKey = "MOCK_" + key.toUpperCase().replace(/-/g, "_");
  return parsedArgs[key] ?? process.env[envKey];
}

function resolveSessionId(): string {
  const configured = getConfig("session-id") as string | undefined;
  if (configured) return configured;
  return randomUUID();
}

// --- Message builders ---

function buildInitMsg(sessionId: string) {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    model: "mock-claude-opus-4",
    cwd: process.cwd(),
  };
}

function buildToolUseMsg(toolName: string, input: Record<string, unknown>, id?: string) {
  return {
    type: "assistant",
    message: {
      id: id ?? "msg_mock_" + randomUUID().slice(0, 8),
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_mock_" + randomUUID().slice(0, 8),
          name: toolName,
          input,
        },
      ],
      model: "mock-claude-opus-4",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 150, output_tokens: 42 },
    },
  };
}

function buildAssistantTextMsg(text: string, id?: string) {
  return {
    type: "assistant",
    message: {
      id: id ?? "msg_mock_" + randomUUID().slice(0, 8),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      model: "mock-claude-opus-4",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 150, output_tokens: 42 },
    },
  };
}

function buildResultMsg(
  sessionId: string,
  text: string,
  startTime: number,
  numTurns: number,
  isError = false,
) {
  const durationMs = Date.now() - startTime;
  return {
    type: "result",
    subtype: isError ? "error" : "success",
    cost_usd: 0.001,
    total_cost_usd: 0.001,
    is_error: isError,
    duration_ms: durationMs,
    duration_api_ms: durationMs,
    num_turns: numTurns,
    result: text,
    session_id: sessionId,
    usage: { input_tokens: 150, output_tokens: 42 },
  };
}

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emit(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// --- Profile implementations ---

async function runStandard(sessionId: string, delayMs: number, resumeId?: string) {
  const startTime = Date.now();

  emit(buildInitMsg(sessionId));
  await sleep(delayMs);

  emit(
    buildToolUseMsg("Read", { file_path: "packages/client/src/components/IssueCard.tsx" }),
  );
  await sleep(delayMs);

  emit(
    buildToolUseMsg("Edit", {
      file_path: "packages/client/src/components/IssueCard.tsx",
      old_string: "old",
      new_string: "new",
    }),
  );
  await sleep(delayMs);

  const text = resumeId
    ? `Resuming session. Mock agent completed the task successfully.`
    : "Mock agent completed the task successfully.";
  emit(buildAssistantTextMsg(text));
  await sleep(delayMs);

  emit(
    buildResultMsg(
      sessionId,
      "Mock agent completed the task successfully. No files were modified.",
      startTime,
      1,
    ),
  );
}

async function runMinimal(sessionId: string, delayMs: number) {
  const startTime = Date.now();

  emit(buildInitMsg(sessionId));
  await sleep(delayMs);

  emit(buildAssistantTextMsg("Mock agent completed the task successfully."));
  await sleep(delayMs);

  emit(
    buildResultMsg(
      sessionId,
      "Mock agent completed the task successfully.",
      startTime,
      1,
    ),
  );
}

async function runMultiTurn(sessionId: string, delayMs: number) {
  const startTime = Date.now();

  emit(buildInitMsg(sessionId));
  await sleep(delayMs);

  // First turn
  emit(buildAssistantTextMsg("Mock agent ready for input."));
  await sleep(delayMs);

  emit(
    buildResultMsg(sessionId, "Mock agent ready for input.", startTime, 1),
  );

  let turnNumber = 2;
  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "user" && parsed.content) {
        const responseText = `Received: ${parsed.content}`;
        emit(buildAssistantTextMsg(responseText));
        await sleep(delayMs);
        emit(buildResultMsg(sessionId, responseText, startTime, turnNumber));
        turnNumber++;
      }
    } catch {
      // Ignore malformed lines
    }
  }
}

async function runError(sessionId: string, delayMs: number) {
  const startTime = Date.now();

  emit(buildInitMsg(sessionId));
  await sleep(delayMs);

  emit(buildAssistantTextMsg("Mock agent encountered an error."));
  await sleep(delayMs);

  emit(
    buildResultMsg(
      sessionId,
      "Mock agent encountered an error. Simulated failure.",
      startTime,
      1,
      true,
    ),
  );

  process.exit(1);
}

// --- Main ---

async function main() {
  const profile = (getConfig("profile") as string) || "standard";
  const delayMs = Number(getConfig("delay-ms")) || 500;
  const sessionId = resolveSessionId();
  const resumeId = getConfig("resume") as string | undefined;

  if (resumeId && typeof resumeId === "string") {
    process.stderr.write(`[mock-agent] resuming session: ${resumeId}\n`);
  }

  switch (profile) {
    case "minimal":
      await runMinimal(sessionId, delayMs);
      break;
    case "multi-turn":
      await runMultiTurn(sessionId, delayMs);
      break;
    case "error":
      await runError(sessionId, delayMs);
      break;
    case "standard":
    default:
      await runStandard(sessionId, delayMs, resumeId as string | undefined);
      break;
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[mock-agent] error: ${err}\n`);
  process.exit(1);
});
