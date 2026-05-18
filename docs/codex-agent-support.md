# Codex Agent Support Plan

## Current State

The app can run a configurable command through `agent_command`, but the integration contract is still Claude-shaped:

- `packages/server/src/services/agent.service.ts` always builds Claude Code flags for real agents: `--output-format stream-json --verbose --mcp-config ... -p`, with optional `--resume`, `--settings`, `--permission-prompt-tool`, and plan-mode flags.
- `packages/server/src/services/session.manager.ts` stores provider resume IDs in `sessions.claudeSessionId` and extracts them only from Claude `system/init` stream-json events.
- `packages/client/src/components/TerminalView.tsx` rendered through a Claude-specific parser; this has now been moved behind a provider-neutral parser factory while preserving Claude stream-json as the default.
- AI helper routes for ticket enhancement, dependency analysis, and setup script generation invoke the configured command with Claude text-output flags.
- Review sessions reuse the same Claude-oriented `startSession` path.

## Local Codex CLI Findings

From the installed `codex` CLI:

- Non-interactive execution is `codex exec [OPTIONS] [PROMPT]`.
- Structured output is available with `codex exec --json`, which prints JSONL events to stdout.
- The working directory is passed with `-C, --cd <DIR>`.
- Sandbox and approval controls are separate flags: `--sandbox`, `--dangerously-bypass-approvals-and-sandbox`, and `--ask-for-approval`.
- Resume exists as `codex exec resume` and top-level `codex resume`; both accept a session ID and prompt. Non-interactive resume support must be verified with actual JSONL output before wiring it into the existing resume chain.
- Codex has its own MCP configuration surface via `codex mcp`; it does not consume Claude's `--mcp-config` flag.

## Incremental Implementation Tickets

These are tracked on the kanban board:

- `#3` Codex support: map CLI capabilities and integration seams.
- `#4` Codex support: introduce agent provider launch abstraction.
- `#5` Codex support: generalize terminal output parsing.
- `#6` Codex support: add provider settings and workspace metadata.
- `#7` Codex support: implement Codex provider and validate workflows.

## Recommended Sequence

1. Keep Claude Code as the default provider and preserve existing flags exactly.
2. Introduce an `AgentProvider` abstraction for command construction, prompt delivery, resume ID extraction, and session stats extraction.
3. Rename persisted fields semantically in code first, then migrate schema later if needed. `claudeSessionId` can be treated as a legacy provider session ID until a DB migration is justified.
4. Add an `agent_provider` preference with values like `claude`, `codex`, and `custom`.
5. Add a Codex provider that starts with raw/JSONL display and no resume assumptions.
6. Once Codex JSONL events are captured from real runs, add a Codex parser for model, tool activity, final result, and stats.
7. Wire provider-specific MCP configuration only after confirming Codex project/global MCP config behavior in this app's worktree model.

## First Refactor Completed

The client terminal parser now depends on `createAgentOutputParser()` in `packages/client/src/lib/agent-output-parser.ts`.

- Claude stream-json rendering remains the default.
- A raw parser is available for unstructured provider output.
- Tests cover parser factory behavior and raw buffering.
