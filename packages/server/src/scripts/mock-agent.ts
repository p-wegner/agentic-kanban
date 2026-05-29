/**
 * Configurable mock agent that emits stream-json output matching Claude's format.
 *
 * Behavior profiles (via --profile or MOCK_AGENT_PROFILE env var):
 *   standard     - Default: init + tool_use(Read/Edit) + text + result (current behavior)
 *   minimal      - Fast: init + text + result
 *   multi-turn   - Stdin-based: first turn + wait for JSONL on stdin + respond per turn
 *   error        - Failure: init + error result, exits with code 1
 *   rate-limit   - Rate limiting: init + rate_limit_event(rejected) + text + rate_limit_event(allowed) + result
 *   todo-progress - TodoWrite events: init + TodoWrite(pending tasks) + TodoWrite(one in_progress) + TodoWrite(all completed) + result
 *   workflow     - Drives a configurable workflow: reads the injected `## Workflow`
 *                  prompt from stdin, then walks the graph by POSTing to the REST
 *                  transition endpoint (KANBAN_SERVER_PORT) — committing a stub file
 *                  per stage — until it hits a fork, join, terminal, or visit cap.
 *                  Lets the mock fully exercise transitions, forks, joins, auto-merge
 *                  and shared-worktree flows with zero token cost.
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

function buildRateLimitMsg(sessionId: string, status: "allowed" | "rejected" = "allowed") {
  return {
    type: "rate_limit_event",
    rate_limit_info: {
      status,
      rateLimitType: "five_hour",
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
      overageStatus: status === "rejected" ? "rejected" : undefined,
      overageDisabledReason: status === "rejected" ? "org_level_disabled" : undefined,
      isUsingOverage: false,
    },
    uuid: randomUUID(),
    session_id: sessionId,
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

async function runTodoProgress(sessionId: string, delayMs: number) {
  const startTime = Date.now();

  emit(buildInitMsg(sessionId));
  await sleep(delayMs);

  // Emit initial TodoWrite with all tasks pending
  emit(
    buildToolUseMsg("TodoWrite", {
      todos: [
        { id: "1", content: "Analyze requirements", status: "pending", priority: "high" },
        { id: "2", content: "Implement feature", status: "pending", priority: "high" },
        { id: "3", content: "Write tests", status: "pending", priority: "medium" },
      ],
    }),
  );
  await sleep(delayMs);

  // Update: first task in_progress
  emit(
    buildToolUseMsg("TodoWrite", {
      todos: [
        { id: "1", content: "Analyze requirements", status: "in_progress", priority: "high" },
        { id: "2", content: "Implement feature", status: "pending", priority: "high" },
        { id: "3", content: "Write tests", status: "pending", priority: "medium" },
      ],
    }),
  );
  await sleep(delayMs);

  // Update: first task complete, second in_progress
  emit(
    buildToolUseMsg("TodoWrite", {
      todos: [
        { id: "1", content: "Analyze requirements", status: "completed", priority: "high" },
        { id: "2", content: "Implement feature", status: "in_progress", priority: "high" },
        { id: "3", content: "Write tests", status: "pending", priority: "medium" },
      ],
    }),
  );
  await sleep(delayMs);

  // Update: all tasks completed
  emit(
    buildToolUseMsg("TodoWrite", {
      todos: [
        { id: "1", content: "Analyze requirements", status: "completed", priority: "high" },
        { id: "2", content: "Implement feature", status: "completed", priority: "high" },
        { id: "3", content: "Write tests", status: "completed", priority: "medium" },
      ],
    }),
  );
  await sleep(delayMs);

  emit(buildAssistantTextMsg("Mock agent completed all tasks."));
  await sleep(delayMs);

  emit(
    buildResultMsg(sessionId, "Mock agent completed all tasks.", startTime, 1),
  );
}

async function runRateLimit(sessionId: string, delayMs: number) {
  const startTime = Date.now();

  emit(buildInitMsg(sessionId));
  await sleep(delayMs);

  emit(buildRateLimitMsg(sessionId, "rejected"));
  await sleep(delayMs);

  emit(buildAssistantTextMsg("Rate limit encountered. Continuing after pause."));
  await sleep(delayMs);

  emit(buildRateLimitMsg(sessionId, "allowed"));
  await sleep(delayMs);

  emit(
    buildResultMsg(
      sessionId,
      "Mock agent completed the task after rate limit.",
      startTime,
      1,
    ),
  );
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

// --- Workflow profile ---

/** Read everything available on stdin. Resolves on EOF, or after an idle gap if
 * stdin is kept open (keepAlive sessions never close it). */
function readStdin(idleMs = 800): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    let timer: NodeJS.Timeout | undefined;
    const done = () => { if (timer) clearTimeout(timer); resolve(buf); };
    const bump = () => { if (timer) clearTimeout(timer); timer = setTimeout(done, idleMs); };
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { buf += chunk; bump(); });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
    bump();
  });
}

/** Pull the workspace id, current stage, and valid next stages out of the
 * `## Workflow` block that the server injects into the agent prompt. */
function parseWorkflowPrompt(prompt: string): {
  workspaceId: string | null;
  currentStage: string | null;
  nextStages: string[];
  isFork: boolean;
} {
  const wsMatch = /workspaceId:\s*"([^"]+)"/.exec(prompt);
  // The join relaunch prepends artifacts/intro text (which may itself contain
  // bullet lists) before the workflow block, so scope parsing to the LAST
  // "## Workflow" block and, for stages, to the "Valid next stages" section only.
  const wfIdx = prompt.lastIndexOf("## Workflow");
  const block = wfIdx >= 0 ? prompt.slice(wfIdx) : prompt;
  const stageMatch = /at the \*\*(.+?)\*\* stage/.exec(block);
  const nextStages: string[] = [];
  const markerIdx = block.indexOf("Valid next stages from here:");
  if (markerIdx >= 0) {
    const lineRe = /^- \*\*(.+?)\*\*/gm;
    let m: RegExpExecArray | null;
    while ((m = lineRe.exec(block.slice(markerIdx))) !== null) nextStages.push(m[1]);
  }
  return {
    workspaceId: wsMatch?.[1] ?? null,
    currentStage: stageMatch?.[1] ?? null,
    nextStages,
    isFork: /parallel fork/i.test(block) && nextStages.length === 0,
  };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "stage";
}

/** Write a stub file for a stage and commit it (best-effort) so diffs/merges are real. */
async function commitStageWork(stage: string): Promise<void> {
  try {
    const { writeFileSync } = await import("node:fs");
    const { execSync } = await import("node:child_process");
    const file = `mock-${slugify(stage)}.md`;
    writeFileSync(file, `# ${stage}\n\nMock contribution for the "${stage}" stage.\n`, "utf-8");
    const opts = { cwd: process.cwd(), stdio: "ignore" as const };
    execSync("git add -A", opts);
    execSync(`git commit -m "mock(${slugify(stage)}): stage work" --no-verify`, opts);
  } catch {
    // No git / nothing to commit / hooks — non-fatal for a mock.
  }
}

async function postTransition(
  workspaceId: string,
  toNodeName: string,
): Promise<{ ok: boolean; nodeType?: string | null; nextStages?: string[]; terminal?: boolean; error?: string }> {
  const port = process.env.KANBAN_SERVER_PORT || process.env.PORT || "3001";
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/workflows/workspaces/${workspaceId}/transition`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toNodeName, summary: `mock advanced to ${toNodeName}` }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: (data.error as string) ?? `HTTP ${res.status}` };
    return {
      ok: true,
      nodeType: (data.nodeType as string) ?? null,
      nextStages: (data.nextStages as string[]) ?? [],
      terminal: (data.terminal as boolean) ?? false,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function runWorkflow(sessionId: string, delayMs: number) {
  const startTime = Date.now();
  emit(buildInitMsg(sessionId));

  const prompt = await readStdin();
  const parsed = parseWorkflowPrompt(prompt);
  process.stderr.write(`[mock-agent:workflow] ws=${parsed.workspaceId} stage=${parsed.currentStage} next=[${parsed.nextStages.join(", ")}] fork=${parsed.isFork}\n`);

  if (!parsed.workspaceId) {
    emit(buildAssistantTextMsg("Mock workflow agent: no workspaceId in prompt — nothing to drive."));
    emit(buildResultMsg(sessionId, "Mock workflow agent: no workflow context.", startTime, 1));
    return;
  }
  if (parsed.isFork) {
    emit(buildAssistantTextMsg("Mock workflow agent: at a parallel fork — the server spawns branches; stopping."));
    emit(buildResultMsg(sessionId, "Mock workflow agent: stopped at parallel fork.", startTime, 1));
    return;
  }

  const visited = new Set<string>();
  let stage = parsed.currentStage ?? "Start";
  let nextStages = parsed.nextStages;
  const MAX_STEPS = 40;
  let steps = 0;
  const log: string[] = [];

  while (nextStages.length > 0 && steps < MAX_STEPS) {
    steps++;
    // Do this stage's work (write + commit a stub file) before advancing.
    await commitStageWork(stage);
    emit(buildToolUseMsg("Write", { file_path: `mock-${slugify(stage)}.md` }));
    await sleep(delayMs);

    // Prefer an unvisited target so self-loops/decision-gates don't dominate.
    const target = nextStages.find((s) => !visited.has(s)) ?? nextStages[0];
    visited.add(target);
    emit(buildAssistantTextMsg(`Completed "${stage}". Advancing to "${target}".`));

    const res = await postTransition(parsed.workspaceId, target);
    if (!res.ok) {
      log.push(`blocked at ${target}: ${res.error}`);
      emit(buildAssistantTextMsg(`Transition to "${target}" was blocked: ${res.error}. Stopping.`));
      break;
    }
    log.push(`${stage} -> ${target} [${res.nodeType ?? "?"}]`);
    stage = target;
    nextStages = res.nextStages ?? [];

    // Stop at control nodes: a fork is server-orchestrated (children spawn), and a
    // child reaching its join must not advance past it (only the parent does that,
    // via a fresh session after consolidation).
    if (res.nodeType === "parallel-fork") {
      emit(buildAssistantTextMsg(`Reached parallel fork "${target}" — server will spawn branches. Stopping.`));
      break;
    }
    if (res.nodeType === "parallel-join") {
      emit(buildAssistantTextMsg(`Reached join "${target}". Stopping (consolidation is server-driven).`));
      break;
    }
    if (res.terminal) {
      emit(buildAssistantTextMsg(`Reached terminal stage "${target}". Workflow complete.`));
      break;
    }
    await sleep(delayMs);
  }

  emit(
    buildResultMsg(
      sessionId,
      `Mock workflow agent walked ${steps} stage(s): ${log.join(", ") || "(no transitions)"}.`,
      startTime,
      steps || 1,
    ),
  );
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
    case "todo-progress":
      await runTodoProgress(sessionId, delayMs);
      break;
    case "rate-limit":
      await runRateLimit(sessionId, delayMs);
      break;
    case "workflow":
      await runWorkflow(sessionId, delayMs);
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
