# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status
Stage 13 complete + Tauri desktop (Stages 0-13 done). Tech stack: TypeScript monorepo — Hono + Drizzle + React + MCP SDK + Tauri v2. Current progress: `docs/state.md`.

## What This Is
Cleanroom reimplementation of [vibe-kanban](https://github.com/BloopAI/vibe-kanban) — a kanban board for managing AI-driven coding tasks. Personal use only, single user, local-first.

## Key Constraints
- **Claude Code only** as the AI agent (no multi-agent support)
- **Local only** — no cloud, no multi-tenant, no OAuth
- **Testability first** — E2E tests from day one, AI-runnable feedback loops
- **Tech stack**: TypeScript (Hono + Drizzle + React + MCP SDK)
- **Server resilience**: Agent subprocess callbacks are wrapped in try/catch in `agent.service.ts`. `uncaughtException`/`unhandledRejection` handlers log with `[fatal]` prefix. Stale sessions cleaned up on startup in `index.ts` after migrations.
- **PR creation is skipped** — manual merge only
- **Always commit** — after finishing a task, commit without waiting to be asked
- **Never use `pnpm db:reset`** — board contains vital dev entries. Delete individual issues/workspaces via MCP tools or API instead.
- Use `uv` and `uv venv` for any Python work (never global site-packages)
- Windows environment

## Architecture Patterns

### Cross-cutting / Windows
- **Hook paths on Windows**: Use **forward slashes** in `settings.json` hook commands. `\\` gets mangled by Claude Code's hook runner → `MODULE_NOT_FOUND`. Relative paths like `.claude/hooks/...` also fail when CWD shifts. `$CLAUDE_PROJECT_DIR` is not expanded in hook command strings.
- **Git tests on Windows**: Use `.trim()` for file content assertions (CRLF vs LF); test git output for keywords, not exact strings.

### Git services (both must stay in sync)
`packages/server/src/services/git.service.ts` and `packages/mcp-server/src/git-service.ts` are duplicates. When adding git operations to either, always update both.

- **Detached HEAD guard in worktrees**: `syncBranchToHead()` forces branch ref to match HEAD before every merge. `ensureOnBranch()` reattaches HEAD after worktree creation and successful rebase.
- **Conflict detection uses `git merge-tree`**: `detectConflicts()` uses `git merge-tree --write-tree --no-messages HEAD <baseBranch>` (read-only). Exit 0 = clean, exit 1 = conflicts. Parse unique filenames from staged-entry records on stdout. Never use `merge --no-commit --no-ff` — it mutates the working tree and races on concurrent requests.
- **Direct workspace diff only shows tracked files**: `git diff HEAD` excludes untracked files. `getWorkingTreeDiff()` also runs `git ls-files --others --exclude-standard` for new files.

### E2E testing
- **Playwright browsers are pre-installed** — do NOT run `playwright install` or `playwright install chromium` in agent sessions. The headless-shell binary is already at `%LOCALAPPDATA%\ms-playwright\chromium_headless_shell-1217\`. Running install again wastes time and may corrupt the lock file. If you see "Executable not found", check `packages/e2e/playwright.config.ts` — it auto-detects the binary path.
- **E2E locator specificity**: `page.locator("text=X")` can match multiple elements — use scoped selectors: `page.locator("label", { hasText: "X" })` or `.first()`.
- **E2E test data cleanup**: Use `test.afterAll` to reset preferences/settings state. Use `Date.now()` suffixes for edited titles — hardcoded titles accumulate across runs. Known flaky: `board.test.ts` "edit issue from detail panel".
- **Pre-existing test failures**: Never dismiss as "pre-existing" without investigating root cause (data accumulation, race condition, API change). Fix if straightforward; document if not.
- **E2E session/workspace tests**: Use retry loops (3 attempts, 500ms–1s delays) for setup and output fetching instead of `test.skip()`.

## Visual Verification
Every feature with UI must be visually verified using the `playwright-cli` skill.
1. Determine ports: in a worktree, use `$env:KANBAN_CLIENT_PORT` / `$env:KANBAN_SERVER_PORT` — never hardcode 3001/5173. Check if server is already listening before starting `pnpm dev`.
2. Use `/playwright-cli` to open `http://localhost:<KANBAN_CLIENT_PORT>` and confirm rendering.
3. Clean up `.png` files and `.playwright-cli/` after. Delete test issues/workspaces via MCP tools — never `pnpm db:reset`.

## Documentation Map
- `.llm/workflows.md` — dev workflows: clean-start setup, DB reset, project registration, migration diagnosis
- `docs/prd/00-executive-summary.md` — vision, keep/skip list
- `docs/prd/05-mvp-scope.md` — MVP definition, 6-stage plan, feature matrix
- `docs/prd/03-data-model.md` — core entities (Project, Issue, Workspace, Session)
- `docs/prd/04-agent-integration.md` — MCP tools, agent lifecycle
- `docs/prd/06-testability-strategy.md` — test pyramid, per-stage test plans
- `docs/decisions/` — numbered decision records
- `docs/state.md` — current progress tracking

## Getting a Ticket Description

When you need to read the full title and description of a ticket by its number, use one of:

| Method | Command |
|---|---|
| CLI (recommended) | `pnpm cli -- issue get <N>` |
| CLI (JSON) | `pnpm cli -- issue get <N> --json` |
| REST API | `GET /api/issues?projectId=<id>&issueNumber=<N>` (returns array) |
| MCP tool | `mcp__agentic-kanban__get_issue` with `issueNumber` |

The CLI `issue get` command works without knowing the project ID — it uses the active project automatically.

## Board Operations: Prefer MCP Tools or CLI over REST

### `#N` means kanban issue, not GitHub PR

When the user references `#N` (e.g., "review #70", "merge #65", "what's the status of #72"), this **always refers to a kanban board issue number**, never a GitHub pull request.

- **"review #N"** → `POST /api/workspaces/:id/review`
- **"merge #N"** → `mcp__agentic-kanban__merge_workspace` or `POST /api/workspaces/:id/merge`
- **"status of #N"** → `get_board_status` or `get_issue` by `issueNumber`

### Use the board's built-in features

| Task | Use the board | Don't do manually |
|---|---|---|
| Review code on a branch | `POST /api/workspaces/:id/review` | Read diff and critique it yourself |
| Merge a branch | `POST /api/workspaces/:id/merge` (or MCP `merge_workspace`) | Run `git merge` directly |
| Fix merge conflicts and retry | `POST /api/workspaces/:id/fix-and-merge` | Manually resolve conflicts in git |
| Start agent work on an issue | `POST /api/workspaces` (creates worktree + launches agent) | Run `claude` directly in a shell |
| Improve a ticket's title/description | `POST /api/issues/enhance` (AI-powered) | Rewrite it yourself |
| Analyze issue dependencies | `POST /api/issues/analyze-dependencies` | Manually read issues and infer deps |
| Rebase a workspace onto latest base | `POST /api/workspaces/:id/update-base` | Run `git rebase` directly |
| Move an issue to a new status | MCP `move_issue` or CLI `issue move` | PATCH via REST unless no tool exists |
| Send a follow-up message to a running agent | `POST /api/workspaces/:id/turn` | Spawn a new claude process |

### MCP Tools are the primary interface

**Use MCP tools for:**
- `mcp__agentic-kanban__create_issue` — create issues (returns `issueNumber`)
- `mcp__agentic-kanban__list_issues` — list/filter issues by status, priority, tag
- `mcp__agentic-kanban__get_issue` — get issue details including workspaces and dependencies
- `mcp__agentic-kanban__update_issue` / `mcp__agentic-kanban__move_issue` — update status, priority, description
- `mcp__agentic-kanban__start_workspace` — create a git worktree for an issue
- `mcp__agentic-kanban__merge_workspace` — merge a workspace branch and close it
- `mcp__agentic-kanban__get_workspace_diff` — inspect changes before merging
- `mcp__agentic-kanban__get_context` — get project info and issue counts
- `mcp__agentic-kanban__get_board_status` — comprehensive overview: all active agents, workspace state, diff stats, session stats, last output
- `mcp__agentic-kanban__list_tags`, `mcp__agentic-kanban__create_tag` — tag management

**Use the CLI (`pnpm cli -- ...`) when MCP is unavailable:**
- `pnpm cli -- issue list/create/move`
- `pnpm cli -- workspace list/create`
- `pnpm cli -- skill list/get/create/export`
- `pnpm cli -- status` — board overview

**Only fall back to REST API** when no MCP tool or CLI equivalent exists.

## Monorepo Commands
- `pnpm dev` — start server + client (auto-detects worktree ports; default: server 3001, client 5173)
- `pnpm dev:desktop` — start server + client + Tauri native window
- `pnpm --filter agentic-kanban test` — Vitest unit tests
- `pnpm test:e2e` — Playwright E2E tests
- `pnpm db:migrate && pnpm db:seed` — initialize DB
- `pnpm cli -- register <path>` — register a git repo as a project
- `pnpm cli -- list` — list registered projects
- `pnpm cli -- cleanup` — show stale worktrees for closed workspaces

## Worktree Port Strategy
`pnpm dev` auto-detects worktree and assigns deterministic ports:
- **Main checkout**: server 3001, client 5173
- **Worktree** (branch `feature/<N>-...`): server `3001+N`, client `5173+N`
- **Worktree** (non-standard branch): server `3001+hash`, client `5173+hash`

**Environment variables available to agents**: `KANBAN_SERVER_PORT`, `KANBAN_CLIENT_PORT`, `SERVER_PORT`, `PORT` (set by both `scripts/dev.mjs` and `agent.service.ts`).

**CRITICAL: Run all commands headlessly — never flash terminal windows.**
- **Never use `Start-Process`** — use `Invoke-Expression`, `&`, or Bash tool instead.
- When spawning processes in Node.js, always add `windowsHide: true`.

**CRITICAL: Never kill ALL node processes.** Kill by specific port or PID:
```powershell
Get-NetTCPConnection -LocalPort <port> | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }
```

**Starting the dev server headlessly (verified):** Use `Start-Job` with the wait loop in the SAME PowerShell call — if the session exits before child processes fully detach, the job dies and nothing starts. Always pass `run_in_background: true` on the PowerShell tool call so Claude Code doesn't block waiting for ports:
```powershell
Start-Job -ScriptBlock { Set-Location C:\andrena\agentic-kanban; pnpm dev 2>&1 } | Out-Null
for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Seconds 1
    $p = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -eq 3001 -or $_.LocalPort -eq 5173 }
    if (($p | Where-Object { $_.LocalPort -eq 3001 }) -and ($p | Where-Object { $_.LocalPort -eq 5173 })) {
        Write-Host "UP after ${i}s"; break
    }
}
```
Do NOT use Bash `&` — creates a fully detached orphan that survives all job/port cleanup.

**Stopping the dev server (verified):** Kill by process signature with `taskkill /F /T` (kills entire subtree). Port sweep alone is not enough — the orchestrator respawns Vite. `Get-Job | Stop-Job` is also not enough — jobs from previous PS sessions aren't visible:
```powershell
Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -like "*dev.mjs*" } |
    ForEach-Object { taskkill /F /T /PID $_.ProcessId 2>$null }
Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like "*vite/bin/vite.js*" } |
    ForEach-Object { taskkill /F /T /PID $_.ProcessId 2>$null }
Get-Job | Stop-Job -ErrorAction SilentlyContinue; Get-Job | Remove-Job -ErrorAction SilentlyContinue
```

**Dangling worktree dev servers:** Worktree `pnpm dev` processes (Vite on 5174, 5175, …; Hono on 3002, 3003, …) survive after a worktree session ends and can grab port 5173/3001. The stop command above catches these too (same `dev.mjs` / `vite.js` signature).

## Workspace Flow
`POST /api/workspaces` (one step): DB record + worktree + auto-launch agent. Key endpoints:
- `POST /api/workspaces/:id/turn` — send follow-up message (multi-turn), 409 if agent still processing
- `GET /api/workspaces/:id/diff` — diffs against `workspace.baseBranch`
- `POST /api/workspaces/:id/merge` — merges into project's `defaultBranch`
- `DELETE /api/workspaces/:id` — cascade-deletes session messages, sessions, workspace

## MVP Core Loop
Register repo → Create issue → New Workspace (one step: branch + worktree + agent) → View diff → Merge

## Agent Skills
Skills are prompt templates in `agent_skills` DB table. Written as `.claude/skills/<name>/SKILL.md` in the worktree on workspace creation.

- **Built-in skills** (`isBuiltin: true`, seeded by `pnpm db:seed`): `board-navigator`, `code-review`, `dependency-analyzer`, `ticket-enhancer`. Cannot be modified/deleted via API.
- **Custom skills**: Created via API/CLI/MCP. Support optional `projectId` scoping.
- **Review prompt**: Uses built-in `code-review` skill. Create a project-scoped `code-review` skill to override. Supports `{{branch}}`, `{{baseBranch}}`, `{{issueId}}`, `{{autoFixInstructions}}` placeholders.
- **API**: `GET/POST/PUT/DELETE /api/agent-skills`. `GET ?projectId=<id>` returns global + project-specific.
- **MCP**: `list_agent_skills`, `get_agent_skill`, `create_agent_skill`, `export_agent_skills`.
