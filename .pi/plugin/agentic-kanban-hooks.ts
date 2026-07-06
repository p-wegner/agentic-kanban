/**
 * agentic-kanban Pi extension - thin adapter for the Claude Code hooks.
 *
 * The safety logic lives in `.claude/hooks/*.js`. This extension translates Pi's
 * `tool_call` events into Claude-shaped hook stdin and returns Pi block results.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@mariozechner/pi-coding-agent";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const HOOKS_DIR = join(PROJECT_DIR, ".claude", "hooks");

interface ScriptResult {
  exitCode: number;
  decision?: { decision?: string; reason?: string };
  stdout: string;
  stderr: string;
}

function runHookScript(scriptArgs: string[], input: unknown): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const child = spawn("node", scriptArgs, {
      cwd: PROJECT_DIR,
      windowsHide: true,
      env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_DIR },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", () => resolve({ exitCode: 0, stdout: "", stderr: "" }));
    child.on("close", (code) => {
      let decision: ScriptResult["decision"];
      const trimmed = stdout.trim();
      if (trimmed.startsWith("{")) {
        try {
          decision = JSON.parse(trimmed);
        } catch {
          // Non-JSON hook output is folded into the block reason below.
        }
      }
      resolve({ exitCode: code ?? 0, decision, stdout, stderr });
    });

    child.stdin.end(JSON.stringify(input ?? {}));
  });
}

function isBlocked(result: ScriptResult): boolean {
  return result.exitCode !== 0 || result.decision?.decision === "block";
}

function blockReason(result: ScriptResult): string {
  return (
    result.decision?.reason ||
    [result.stderr, result.stdout].map((part) => part.trim()).filter(Boolean).join("\n") ||
    "Blocked by agentic-kanban hook."
  );
}

function pathInput(event: ToolCallEvent): string {
  const input = event.input as Record<string, unknown>;
  return String(input.path ?? input.file_path ?? input.filePath ?? "");
}

export default function AgenticKanbanHooks(pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName === "bash") {
      const input = event.input as Record<string, unknown>;
      const hookInput = {
        tool_name: "Bash",
        tool_input: {
          command: String(input.command ?? ""),
          cwd: PROJECT_DIR,
        },
        cwd: PROJECT_DIR,
      };
      const result = await runHookScript(
        [join(HOOKS_DIR, "smart-hooks-runner.js"), "PreToolUse"],
        hookInput,
      );
      if (isBlocked(result)) return { block: true, reason: blockReason(result) };

      // Vital-file destruction guard (#972) — same gate .claude/settings.json and
      // .codex/hooks.json wire for shell commands. (require-read-before-write is
      // deliberately NOT wired here: that constraint is Claude-Code-specific.)
      const vitalResult = await runHookScript(
        [join(HOOKS_DIR, "vital-file-guard.js")],
        hookInput,
      );
      if (isBlocked(vitalResult)) return { block: true, reason: blockReason(vitalResult) };
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const claudeTool = event.toolName === "write" ? "Write" : "Edit";
      const result = await runHookScript(
        [join(HOOKS_DIR, "prevent-cross-worktree-writes.js")],
        {
          tool_name: claudeTool,
          tool_input: { file_path: pathInput(event) },
          cwd: PROJECT_DIR,
        },
      );
      if (isBlocked(result)) return { block: true, reason: blockReason(result) };
    }

    return undefined;
  });
}
