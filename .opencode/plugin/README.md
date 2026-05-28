# OpenCode plugin — port of the Claude Code hooks

`agentic-kanban-hooks.ts` reproduces the behavior of the Claude Code hooks
(`.claude/hooks/` + the `hooks` block in `.claude/settings.json`) for OpenCode.

OpenCode auto-loads any `.ts`/`.js` in `.opencode/plugin/` at startup — no config
entry is required. (You can also publish a plugin as an npm package and list it
under `plugin` in `opencode.json`; we don't need that here.)

## Design: thin adapter, not a rewrite

The plugin does **not** re-implement the hook logic. It spawns the existing
`.claude/hooks/*.js` scripts with synthesized Claude-style stdin and translates
their result back into OpenCode terms. This keeps a single source of truth for
the DB-destruction guard and cross-worktree guard — logic CLAUDE.md explicitly
forbids weakening or routing around.

## Hook mapping

| Claude Code hook | OpenCode hook | Underlying script |
|---|---|---|
| `PreToolUse` (Bash\|PowerShell) | `tool.execute.before`, `tool === "bash"` | `smart-hooks-runner.js PreToolUse` → `validate-command-safety.js` |
| `PreToolUse` (Write\|Edit\|MultiEdit\|NotebookEdit) | `tool.execute.before`, `tool ∈ {write, edit}` | `prevent-cross-worktree-writes.js` |
| `PostToolUse` (Write\|Edit\|MultiEdit) | `tool.execute.after`, `tool ∈ {write, edit}` | `smart-hooks-runner.js PostToolUse` |
| `Stop` | `event` → `session.idle` | `smart-hooks-runner.js Stop` |

**Blocking:** Claude's `{ decision: "block" }` + exit 2 becomes a thrown `Error`
in `tool.execute.before` — OpenCode aborts the tool call and shows the message
to the model.

## Differences from Claude Code (read these)

1. **No PowerShell tool.** OpenCode runs shell commands through the single
   `bash` tool, so the command-safety guard hooks only `bash`. The underlying
   `validate-command-safety.js` already matched both `command` and `Command`, so
   PowerShell-style commands are still inspected.

2. **No MultiEdit / NotebookEdit tools.** OpenCode's file edits go through
   `write` and `edit`. The Notebook path simply doesn't exist here.

3. **The `Stop` hook is a soft nudge, not a hard gate.** This is the one mapping
   that isn't equivalent. Claude's `Stop` can *block* the agent from ending and
   force a re-prompt; OpenCode's `session.idle` event fires *after* the turn has
   ended and cannot veto it. The plugin runs the same Stop checks (vitest, build,
   playwright reminder, uncommitted, cleanup) and, if they fail, re-injects the
   reason as a follow-up prompt via `client.session.prompt(...)`, guarded by a
   per-session set so it nudges at most once per idle cycle. If the SDK call
   shape doesn't match the installed OpenCode version, it falls back to logging.
   → If you need a *hard* pre-completion gate, the robust place for it in OpenCode
   is CI / a pre-commit hook, not the agent runtime.

4. **`CLAUDE_PROJECT_DIR`.** The scripts key off this env var. The plugin sets it
   to `process.cwd()` (the worktree OpenCode launched in) when it isn't already
   set, matching how the Claude hook runner resolved it.

## Verifying the SDK surface

`client.session.prompt(...)` and the `event` property names
(`event.properties.sessionID`) are taken from the documented plugin API but
weren't checkable against a local install (OpenCode isn't installed on this
machine). After installing OpenCode, confirm against
`@opencode-ai/plugin`'s types and adjust the `event` handler if field names differ.
