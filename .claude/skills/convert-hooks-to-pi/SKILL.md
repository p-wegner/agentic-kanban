---
name: convert-hooks-to-pi
description: Convert Claude Code hooks (.claude/settings.json hooks block + .claude/hooks/ scripts) into an equivalent Pi extension under .pi/plugin/. Use when porting a repo's hook automation from Claude Code to Pi.
argument-hint: "[path to .claude/settings.json, defaults to current repo]"
---

# convert-hooks-to-pi

Port a repo's Claude Code hooks to a Pi extension. Claude Code declares hooks in a `hooks` block in `settings.json`; Pi loads TypeScript extension modules with `--extension <path>` and lets them register lifecycle handlers with `pi.on(...)`.

**Core principle: adapt, don't rewrite.** For non-trivial hooks, make the Pi extension a thin adapter that re-runs the existing `.claude/hooks/*.js` scripts with synthesized Claude-shaped stdin and translates the result back. Keep DB-safety and cross-worktree guard logic in one place.

## Step 1: Inventory the existing hooks

1. Read `.claude/settings.json` and `.claude/settings.local.json` hook blocks.
2. Read every invoked `.claude/hooks/*.js` script and note its stdin shape, block output (`{ "decision": "block", "reason": "..." }`), exit codes, and environment variables.

## Step 2: Apply the mapping

| Claude Code hook | Pi equivalent | How to block |
|---|---|---|
| `PreToolUse` for `Bash` / `PowerShell` | `pi.on("tool_call")`, `event.toolName === "bash"` | Return `{ block: true, reason }` |
| `PreToolUse` for `Write` / `Edit` / `MultiEdit` | `pi.on("tool_call")`, `event.toolName === "write" || "edit"` | Return `{ block: true, reason }` |
| `PostToolUse` for write tools | `pi.on("tool_result")` | After-the-fact only; use only for state tracking |
| `Stop` | no exact hard-stop equivalent in non-interactive one-shot runs | Prefer main-checkout commit guards or a later session-end adapter |

Pi 0.73.1 supports hard pre-tool veto through `tool_call`; use it for DB-safety and cross-worktree write guards. Pi 0.73.1 rejects `--approve`, so do not add it when wiring extensions.

## Step 3: Write the extension

Create `.pi/plugin/<repo>-hooks.ts`:

```typescript
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const HOOKS_DIR = join(PROJECT_DIR, ".claude", "hooks");

export default function RepoHooks(pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName === "bash") {
      const result = await runHookScript(
        [join(HOOKS_DIR, "smart-hooks-runner.js"), "PreToolUse"],
        { tool_name: "Bash", tool_input: { command: event.input.command }, cwd: PROJECT_DIR },
      );
      if (blocked(result)) return { block: true, reason: reason(result) };
    }
  });
}
```

Use the adapter helpers from `.pi/plugin/agentic-kanban-hooks.ts` rather than retyping them.

## Step 4: Wire and verify

1. Add repeated `--extension <path>` flags to Pi launch args for the adapter.
2. Add repeated `--skill <path>` flags for each materialized `SKILL.md`.
3. Verify with a harmless command first, then with a command the DB-safety hook blocks.
4. Leave the original `.claude/hooks/*.js` scripts in place.
