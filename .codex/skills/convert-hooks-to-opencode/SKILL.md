---
name: convert-hooks-to-opencode
description: Convert Claude Code hooks (.claude/settings.json hooks block + .claude/hooks/ scripts) into an equivalent OpenCode plugin under .opencode/plugin/. Use when porting a repo's hook automation from Claude Code to OpenCode.
argument-hint: "[path to .claude/settings.json, defaults to current repo]"
---

# convert-hooks-to-opencode

Port a repo's Claude Code hooks to an OpenCode plugin. Claude Code declares hooks in a `hooks` block in `settings.json` pointing at scripts; OpenCode has **no hooks config block** — instead you drop a TS/JS plugin into `.opencode/plugin/` exporting a function that returns a hooks object, auto-loaded at startup.

**Core principle — adapt, don't rewrite.** For non-trivial hooks (safety guards, stateful checks), make the plugin a **thin adapter** that re-runs those same scripts with synthesized Claude-shaped stdin and translates the result back — one source of truth, no divergence from hard-won guard logic. Re-implement inline only for trivial one-liners.

## Step 1: Inventory the existing hooks

1. Read `.claude/settings.json` (+ `settings.local.json`) `hooks` block: each event (`PreToolUse`, `PostToolUse`, `Stop`, `UserPromptSubmit`, `SessionStart`, …), its `matcher`, the command.
2. Read every invoked script (usually `.claude/hooks/*.js`): what stdin shape it expects, what it emits (`{decision:"block",reason}` on stdout, exit codes), and any env vars / override flags it honors.

## Step 2: Apply the mapping

| Claude Code hook | OpenCode equivalent | How to block |
|---|---|---|
| `PreToolUse` (Bash\|PowerShell) | `tool.execute.before`, `input.tool === "bash"` | `throw new Error(reason)` aborts the call |
| `PreToolUse` (Write\|Edit\|MultiEdit\|NotebookEdit) | `tool.execute.before`, `input.tool ∈ {"write","edit"}` | `throw` |
| `PostToolUse` (Write\|Edit\|…) | `tool.execute.after`, same tool match | (after-the-fact; can't block) |
| `Stop` | `event` handler → `event.type === "session.idle"` | **cannot hard-block** — see caveat |
| `UserPromptSubmit` | `event` → `session.updated` / message events (version-dependent) | varies |

**Tool-name differences (critical):**
- OpenCode tool names are **lowercase**: `bash`, `write`, `edit`, `read`, `glob`, `grep`.
- OpenCode has **no PowerShell tool** — all shell runs through `bash`. Hook only `bash`.
- OpenCode has **no MultiEdit or NotebookEdit** — only `write` and `edit`.
- In `tool.execute.before(input, output)`: `input.tool` is the tool name;
  `output.args` holds the (mutable) arguments. For bash, `output.args.command`;
  for write/edit, `output.args.filePath`.

**The `Stop` caveat (the one imperfect mapping):** OpenCode's `session.idle` fires *after* the turn ends and **cannot veto it** the way Claude's `Stop` blocks-and-re-prompts. Best available: run the Stop checks on idle and, if they fail, re-inject the reason via `client.session.prompt({ sessionID, parts:[{type:"text",text:reason}] })`, guarded by a per-session `Set` so it nudges at most once per idle cycle (clear the entry when the session goes active again). This is a **soft nudge, not a hard gate** — for a true pre-completion gate, CI or a pre-commit hook is the reliable place.

## Step 3: Write the plugin

Create `.opencode/plugin/<repo>-hooks.ts`. Skeleton (adapter style):

```typescript
import { spawn } from "node:child_process";
import { join } from "node:path";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const HOOKS_DIR = join(PROJECT_DIR, ".claude", "hooks");

function runHookScript(args: string[], input: unknown, extraEnv: Record<string,string> = {}) {
  return new Promise<{ exitCode: number; decision?: any; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("node", args, {
      cwd: PROJECT_DIR, windowsHide: true,
      env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_DIR, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", () => resolve({ exitCode: 0, stdout: "", stderr: "" }));
    child.on("close", (code) => {
      let decision; const t = stdout.trim();
      if (t.startsWith("{")) { try { decision = JSON.parse(t); } catch {} }
      resolve({ exitCode: code ?? 0, decision, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(input ?? {}));
  });
}
const blocked = (r: any) => r.exitCode !== 0 || r.decision?.decision === "block";
const reason  = (r: any) => r.decision?.reason || [r.stderr, r.stdout].map((s:string)=>s.trim()).filter(Boolean).join("\n") || "Blocked.";

const nudged = new Set<string>();

export const RepoHooks = async ({ client }: { client: any }) => ({
  "tool.execute.before": async (input: any, output: any) => {
    if (input.tool === "bash") {
      const r = await runHookScript([join(HOOKS_DIR, "<pretooluse-runner>.js"), "PreToolUse"],
        { tool_name: "Bash", tool_input: { command: output.args?.command ?? "" } });
      if (blocked(r)) throw new Error(reason(r));
    }
    if (input.tool === "write" || input.tool === "edit") {
      const fp = output.args?.filePath ?? output.args?.file_path ?? "";
      const r = await runHookScript([join(HOOKS_DIR, "<write-guard>.js")],
        { tool_name: input.tool === "write" ? "Write" : "Edit", tool_input: { file_path: fp } });
      if (blocked(r)) throw new Error(reason(r));
    }
  },
  "tool.execute.after": async (input: any, output: any) => {
    if (input.tool !== "write" && input.tool !== "edit") return;
    const fp = output?.args?.filePath ?? output?.args?.file_path ?? "";
    if (fp) await runHookScript([join(HOOKS_DIR, "<posttooluse-runner>.js"), "PostToolUse"],
      { tool_name: input.tool === "write" ? "Write" : "Edit", tool_input: { file_path: fp } });
  },
  event: async ({ event }: { event: any }) => {
    const sid = event.properties?.sessionID ?? event.properties?.info?.id;
    if (event.type !== "session.idle") { if (sid) nudged.delete(sid); return; }
    if (!sid || nudged.has(sid)) return;
    const r = await runHookScript([join(HOOKS_DIR, "<stop-runner>.js"), "Stop"],
      { session_id: sid, stop_hook_active: false });
    if (blocked(r)) {
      nudged.add(sid);
      try { await client.session.prompt({ sessionID: sid, parts: [{ type: "text", text: reason(r) }] }); }
      catch { try { await client.app.log({ body: { level: "warn", message: reason(r) } }); } catch {} }
    }
  },
});
```

Replace `<...>` with the actual script names from Step 1, drop hook arms the repo doesn't use, and for a trivial inline command (not a script) implement it directly instead of spawning.

## Step 4: Document and verify

1. Write `.opencode/plugin/README.md`: the mapping table, tool-name differences, and the `Stop` soft-nudge caveat. Note which SDK fields (`client.session.prompt`, `event.properties.sessionID`) are doc-sourced and should be re-confirmed against `@opencode-ai/plugin` types once OpenCode is installed.
2. Syntax-check (types usually absent → transpile-only):
   ```bash
   npx --no-install esbuild .opencode/plugin/<repo>-hooks.ts --bundle --platform=node --external:node:* --format=esm > /dev/null && echo "SYNTAX OK"
   ```
3. Leave the original `.claude/hooks/*.js` in place — the adapter reuses them; never delete or weaken a safety-guard script.

## Reporting

Tell the user: where the plugin lives, the mapping applied, and the three Claude-Code differences — no PowerShell/MultiEdit/NotebookEdit tools, `Stop` is a soft nudge not a hard gate, and the SDK surface needs confirming against the installed OpenCode version.
