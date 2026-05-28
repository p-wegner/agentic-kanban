# Decision 003: Butler Architecture — Agent SDK vs CLI Subprocess

## Date: 2026-05-28

## Context
Decision 001 left open: "Use Claude Agent SDK directly, or subprocess Claude Code CLI?"
In practice the answer is **both, for different roles**:
- **Task agents** (one per kanban issue) — keep the **CLI subprocess** model: isolated in a git worktree, resumable via `--resume`, survives server hot-reloads, one-shot per task.
- **Butler** (the per-project conversational assistant) — use the **Claude Agent SDK** in-process.

This record covers the Butler choice.

## Decision
Run the Butler as a warm, in-process **Claude Agent SDK** session (one per project), NOT as a CLI spawn per message.

- `butler-sdk.service.ts` owns a `Map<projectId, ButlerSession>`; turns are fed into a single `query({ prompt: AsyncIterable<SDKUserMessage> })` via a `Pushable` queue, so conversation context stays warm across turns.
- Auth/profile reuse the same `buildSpawnEnv(profile)` env as the rest of the app (CLI login / API key / Bedrock / z.ai). SDK `session_id` is persisted to `butler_session_<projectId>` and passed as `resume`, so the butler survives server restarts.
- Model switches live via `query.setModel()` (no restart); profile switches restart the session (different endpoint can't resume). Turns can be interrupted via `query.interrupt()`.
- SSE listeners are kept in a project-keyed registry, independent of the session lifecycle, so the stream survives clear-context / profile-restart.

## Rationale
1. **Streaming on Windows**: keeping a `claude.exe` warm with stdin open does NOT stream — it buffers stdout until stdin closes. The SDK is a library call with a native async iterator: true token-delta streaming with no stdio/TTY buffering.
2. **Warm context, no respawn**: conversation history lives in-process across turns; no `--resume` cold start per message.
3. **Control requests**: the SDK exposes `setModel`, `interrupt`, `supportedCommands`, and `getContextUsage` mid-session — enabling the live model picker, Stop button, slash-command autocomplete, and an accurate context-usage readout (true occupancy, not the cache-inflated turn-usage sum).
4. **Task agents stay CLI**: they need worktree isolation and to survive the orchestrator's hot-reloads; the SDK's in-process model would tie their lifecycle to the server. So the split is deliberate.

## Consequences
- The Butler runs with `permissionMode: "bypassPermissions"` — there is no human in the chat loop to approve tool prompts.
- A bundled, user-facing board-usage UI guide (`butler/board-guide.ts`) is written to disk per session and referenced via the `{{boardGuidePath}}` prompt placeholder, read on demand (progressive disclosure) so it stays out of every turn's context.
- The Butler orchestrates board work via the one-step `POST /api/workspaces` flow (worktree + move to In Progress + launch), never the bare `start_workspace` MCP tool, and verifies via `get_issue`/`get_board_status` before reporting success.
- Implementation/operational detail is maintained in `packages/server/CLAUDE.md` (the "Butler" section).

## Resolved
- [x] ~~Use Claude Agent SDK directly, or subprocess Claude Code CLI?~~ -> **SDK for the Butler, CLI subprocess for task agents** (resolves the open item from Decision 001)
- [x] One warm session per project, keyed by `projectId`, resumed via preference
- [x] Live model switch (no restart) vs profile switch (restart)
