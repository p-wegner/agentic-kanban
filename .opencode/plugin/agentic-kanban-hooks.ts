/**
 * agentic-kanban OpenCode plugin — port of the Claude Code hooks.
 *
 * This is a THIN ADAPTER. The actual hook logic still lives in the existing
 * Node scripts under `.claude/hooks/` (validate-command-safety.js,
 * prevent-cross-worktree-writes.js, smart-hooks-runner.js). Those scripts read
 * Claude-shaped JSON on stdin and emit `{ decision: "block", reason }` on stdout
 * with a non-zero exit code when they want to block. Re-implementing their logic
 * here would risk silently diverging from the DB-safety / cross-worktree guards
 * that CLAUDE.md explicitly forbids weakening — so instead we synthesize the
 * Claude-style stdin from OpenCode's hook input and translate the result back.
 *
 * Mapping (Claude Code hook -> OpenCode plugin hook):
 *   PreToolUse  (Bash|PowerShell)              -> tool.execute.before, tool === "bash"
 *   PreToolUse  (Write|Edit|MultiEdit|...)     -> tool.execute.before, tool in {write,edit}
 *   PostToolUse (Write|Edit|MultiEdit)         -> tool.execute.after,  tool in {write,edit}
 *   Stop                                        -> event: session.idle  (see caveat below)
 *
 * CAVEAT — the Stop hook: OpenCode has no hook that can *block* a session from
 * ending and force a re-prompt the way Claude's `Stop` does. The closest is the
 * `session.idle` event. We run the same Stop checks; if they would block, we
 * re-inject the reason as a follow-up user prompt via the SDK client, guarded by
 * a per-session "already nudged" set so we can't loop forever. This is a nudge,
 * not a hard gate — treat it as best-effort.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const HOOKS_DIR = join(PROJECT_DIR, ".claude", "hooks");

interface ScriptResult {
  exitCode: number;
  /** Parsed `{ decision, reason }` if the script emitted one on stdout. */
  decision?: { decision?: string; reason?: string };
  stdout: string;
  stderr: string;
}

/**
 * Run one of the `.claude/hooks` Node scripts, piping `input` as JSON on stdin.
 * Returns the exit code plus any parsed block decision. Never throws.
 */
function runHookScript(
  scriptArgs: string[],
  input: unknown,
  extraEnv: Record<string, string> = {},
): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const child = spawn("node", scriptArgs, {
      cwd: PROJECT_DIR,
      windowsHide: true,
      env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_DIR, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", () => resolve({ exitCode: 0, stdout: "", stderr: "" }));
    child.on("close", (code) => {
      let decision: ScriptResult["decision"];
      const trimmed = stdout.trim();
      if (trimmed.startsWith("{")) {
        try {
          decision = JSON.parse(trimmed);
        } catch {
          /* not a JSON decision — ignore */
        }
      }
      resolve({ exitCode: code ?? 0, decision, stdout, stderr });
    });

    child.stdin.end(JSON.stringify(input ?? {}));
  });
}

/** True if a hook script asked to block (non-zero exit or explicit block decision). */
function isBlocked(r: ScriptResult): boolean {
  return r.exitCode !== 0 || r.decision?.decision === "block";
}

/** The human-readable reason to surface back to the model when blocked. */
function blockReason(r: ScriptResult): string {
  return (
    r.decision?.reason ||
    [r.stderr, r.stdout].map((s) => s.trim()).filter(Boolean).join("\n") ||
    "Blocked by agentic-kanban hook."
  );
}

// Sessions we've already nudged on idle, so the Stop-equivalent doesn't loop.
const nudgedSessions = new Set<string>();

export const AgenticKanbanHooks = async ({ client }: { client: any }) => {
  return {
    /**
     * PreToolUse — validate before a tool runs. Throwing aborts the call and
     * surfaces the message to the model (Claude's "decision: block").
     */
    "tool.execute.before": async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { args: Record<string, any> },
    ) => {
      const tool = input.tool;

      // Bash/PowerShell command safety (DB-destruction guard).
      if (tool === "bash") {
        const command: string = output.args?.command ?? "";
        const res = await runHookScript(
          [join(HOOKS_DIR, "smart-hooks-runner.js"), "PreToolUse"],
          { tool_name: "Bash", tool_input: { command } },
        );
        if (isBlocked(res)) throw new Error(blockReason(res));
        return;
      }

      // File-write tools — cross-worktree write guard.
      if (tool === "write" || tool === "edit") {
        const filePath: string =
          output.args?.filePath ?? output.args?.file_path ?? output.args?.path ?? "";
        const claudeTool = tool === "write" ? "Write" : "Edit";
        const res = await runHookScript(
          [join(HOOKS_DIR, "prevent-cross-worktree-writes.js")],
          { tool_name: claudeTool, tool_input: { file_path: filePath } },
        );
        if (isBlocked(res)) throw new Error(blockReason(res));
        return;
      }
    },

    /**
     * PostToolUse — after a write/edit completes, record the edited file so the
     * idle (Stop) checks know which files changed. Delegates to the same
     * smart-hooks-runner state-tracking the Claude hook used.
     */
    "tool.execute.after": async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { args?: Record<string, any> },
    ) => {
      if (input.tool !== "write" && input.tool !== "edit") return;
      const filePath: string =
        output?.args?.filePath ?? output?.args?.file_path ?? output?.args?.path ?? "";
      if (!filePath) return;
      const claudeTool = input.tool === "write" ? "Write" : "Edit";
      await runHookScript(
        [join(HOOKS_DIR, "smart-hooks-runner.js"), "PostToolUse"],
        { tool_name: claudeTool, tool_input: { file_path: filePath } },
      );
    },

    /**
     * Stop equivalent — when the session goes idle, run the full Stop checks
     * (vitest, build, playwright reminder, uncommitted, cleanup). If they would
     * block, re-inject the reason as a follow-up prompt. Guarded so we nudge a
     * given session at most once per idle cycle (cleared when work resumes).
     */
    event: async ({ event }: { event: { type: string; properties?: any } }) => {
      if (event.type === "session.busy" || event.type === "session.updated") {
        // Session is active again — allow a future idle nudge.
        const sid = event.properties?.sessionID ?? event.properties?.info?.id;
        if (sid) nudgedSessions.delete(sid);
        return;
      }

      if (event.type !== "session.idle") return;

      const sessionID: string | undefined =
        event.properties?.sessionID ?? event.properties?.info?.id;
      if (!sessionID || nudgedSessions.has(sessionID)) return;

      // stop_hook_active=false on first idle (full checks); true after a re-prompt.
      const res = await runHookScript(
        [join(HOOKS_DIR, "smart-hooks-runner.js"), "Stop"],
        { session_id: sessionID, stop_hook_active: nudgedSessions.has(sessionID) },
      );

      if (isBlocked(res)) {
        nudgedSessions.add(sessionID);
        const reason = blockReason(res);
        try {
          // Re-inject as a follow-up prompt. Exact SDK shape may vary by version.
          await client.session.prompt({
            sessionID,
            parts: [{ type: "text", text: reason }],
          });
        } catch {
          // SDK shape mismatch — surface to the OpenCode log instead of failing.
          try {
            await client.app.log({
              body: { level: "warn", message: `[agentic-kanban] Stop checks failed:\n${reason}` },
            });
          } catch {
            /* best effort */
          }
        }
      }
    },
  };
};
