#!/usr/bin/env node
/**
 * agentic-kanban Herdr adapter (#1146) - thin bridge to the Claude Code hooks.
 *
 * The safety logic lives in `.claude/hooks/*.js` (DB-safety, cross-worktree writes,
 * command-safety) and must not be reimplemented anywhere else — see `.pi/plugin/
 * agentic-kanban-hooks.ts` for the sibling adapter that does the same thing for Pi's
 * `tool_call` extension event.
 *
 * Herdr itself is a terminal multiplexer, not a model runtime: it drives an agent CLI
 * (claude/codex/pi/…) inside a managed pane and has no `tool_call`-style extension hook
 * of its own to subscribe to (unlike Pi's `--extension` mechanism). So this module is not
 * loaded by Herdr automatically — it exposes the same PreToolUse-shaped evaluation as a
 * plain function, for anything that sits between Herdr and the driven agent (a wrapper
 * script, a future Herdr hook API, or a test) to call before letting a tool call reach the
 * pane. Whatever calls it is responsible for turning its `{block, reason}` result into a
 * refusal the driven agent actually sees.
 *
 * Bash/PowerShell commands flow through `smart-hooks-runner.js PreToolUse` (one process
 * for the command-safety + vital-file + cross-worktree shell guards, #914). Write/Edit
 * calls flow through `prevent-cross-worktree-writes.js`. Both are hard pre-execution
 * blocks — exactly the Claude/Codex/Pi contract (root CLAUDE.md, "Board Feedback
 * Conventions" / packages/server/CLAUDE.md, "Pi task agents").
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const HOOKS_DIR = join(PROJECT_DIR, ".claude", "hooks");

function runHookScript(scriptArgs, input) {
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
      let decision;
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

function isBlocked(result) {
  return result.exitCode !== 0 || result.decision?.decision === "block";
}

function blockReason(result) {
  return (
    result.decision?.reason ||
    [result.stderr, result.stdout].map((part) => part.trim()).filter(Boolean).join("\n") ||
    "Blocked by agentic-kanban hook."
  );
}

/**
 * Evaluate one herdr-relayed tool call against the shared guards.
 *
 * `toolName` uses the Claude Code vocabulary ("Bash", "PowerShell", "Write", "Edit",
 * "MultiEdit", "NotebookEdit") since that is what the shared hook scripts expect and what
 * herdr's default driven agent (Claude) emits — see `parseAgentProviderStreamLine`'s
 * `case "herdr"` comment ("Claude is the default driven agent").
 *
 * Returns `{ block: false }` for anything the guards don't cover (mirrors Pi's adapter,
 * which returns `undefined` for the same case — this returns an explicit object instead
 * so a caller need not special-case `undefined`).
 */
export async function evaluateHerdrToolCall(toolName, toolInput, cwd = PROJECT_DIR) {
  const input = toolInput ?? {};

  if (toolName === "Bash" || toolName === "PowerShell") {
    const result = await runHookScript(
      [join(HOOKS_DIR, "smart-hooks-runner.js"), "PreToolUse"],
      { tool_name: toolName, tool_input: { command: String(input.command ?? ""), cwd }, cwd },
    );
    if (isBlocked(result)) return { block: true, reason: blockReason(result) };
    return { block: false };
  }

  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
    const filePath = String(input.file_path ?? input.path ?? input.filePath ?? "");
    const result = await runHookScript(
      [join(HOOKS_DIR, "prevent-cross-worktree-writes.js")],
      { tool_name: toolName, tool_input: { file_path: filePath }, cwd },
    );
    if (isBlocked(result)) return { block: true, reason: blockReason(result) };
    return { block: false };
  }

  return { block: false };
}
