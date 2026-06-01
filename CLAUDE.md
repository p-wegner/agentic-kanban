# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status
Stage 13 complete + Tauri desktop (Stages 0-13 done). Tech stack: TypeScript monorepo — Hono + Drizzle + React + MCP SDK + Tauri v2. Current progress: `docs/state.md`. Feature catalog visually verified: 2026-05-29.

## Active Project
The active project is "agentic-kanban" — always use this for board monitor cycles, workspace operations, and MCP tools.

**Note:** On server startup, `deduplicateProjects()` automatically removes legacy duplicate projects (e.g. a "server" project registered from `packages/server` before git-root resolution was added). If you see two projects for the same repo, restart the server — it will self-heal.

## What This Is
Cleanroom reimplementation of [vibe-kanban](https://github.com/BloopAI/vibe-kanban) — a kanban board for managing AI-driven coding tasks. Personal use only, single user, local-first.

## Scope Constraints

**Keep changes minimal and focused on the original task.** Agents tend to expand scope during refactoring — resist this.

- **Only change what the task requires.** If you're fixing a bug, fix only that bug. If you're refactoring a function, refactor only that function.
- **Don't fix pre-existing issues** unless they are directly blocking your task or tightly coupled to the code you're changing.
- **Don't rename, restructure, or reformat** code outside the immediate scope — even if it "looks messy".
- **Don't add features while refactoring.** Refactors should be behavior-preserving by definition.
- **When you notice other issues**, create a kanban ticket for them instead of fixing them inline. Use `mcp__agentic-kanban__create_issue` or `pnpm cli -- issue create`.
- **Stop and verify scope before committing.** Run `git diff --stat HEAD` and check: does every changed file relate directly to the task? If not, revert the unrelated changes.

> **Signal of scope creep**: touching more than 3–4 files for a task that sounds like a small change, or changing files whose names don't appear in the ticket description.

## Key Constraints
- **Multiple agent providers** supported — Claude Code, Codex, and Copilot — selectable via the Agent Profile dropdown (Settings → Agent). Each provider has named profiles; Claude uses `~/.claude/settings_*.json`, Codex uses `~/.codex/<name>.config.toml`, Copilot uses the CLI default or a configured model profile.
- **Local only** — no cloud, no multi-tenant, no OAuth
- **Testability first** — E2E tests from day one, AI-runnable feedback loops
- **Tech stack**: TypeScript (Hono + Drizzle + React + MCP SDK)
- **Server resilience**: Agent subprocess callbacks are wrapped in try/catch in `agent.service.ts`. `uncaughtException`/`unhandledRejection` handlers log with `[fatal]` prefix. Stale sessions cleaned up on startup in `index.ts` after migrations.
- **PR creation is skipped** — manual merge only
- **Always commit** — after finishing a task, commit without waiting to be asked
- **Never delete or wipe `kanban.db`** (no `pnpm db:reset`, no `rm`/`Remove-Item`/truncate/`Out-File` on the db file, no alternate paths like `/mnt/c/...`). The board contains vital dev entries. Delete individual issues/workspaces via MCP tools or API instead.
  - **Migrations won't apply / db locked / stale WAL?** Run **`pnpm db:repair`** (backs up, WAL-checkpoints, integrity-checks, then migrates in place). It is the correct first move — deletion never fixes those. The `drizzle-kit migrate` *CLI* can hang; the programmatic migrator in `db:repair` works.
  - A **PreToolUse guard** (`.claude/hooks/validate-command-safety.js`) blocks destructive-db commands and auto-backs-up to `packages/server/.db-backups/`. **When it fires, STOP and ask the user — never weaken the hook, truncate the file, or route around it via a different path/verb.** See `docs/learnings/2026-05-24-agent-circumvented-db-deletion-guardrail.md`.
- Use `uv` and `uv venv` for any Python work (never global site-packages)
- Windows environment

## Architecture Patterns

### Cross-cutting / Windows
- **Hook paths on Windows**: Use **forward slashes** in `settings.json` hook commands. `\\` gets mangled by Claude Code's hook runner → `MODULE_NOT_FOUND`. Relative paths like `.claude/hooks/...` also fail when CWD shifts. `$CLAUDE_PROJECT_DIR` is not expanded in hook command strings.
- **Codex hook parity**: `.codex/hooks.json` must route Codex `PreToolUse` shell checks through `.claude/hooks/smart-hooks-runner.js` so Claude and Codex share the same safety policy. It must also route Codex patch/write tools through `.claude/hooks/prevent-cross-worktree-writes.js`. When adding a new Claude safety hook, make it work with Codex hook input too (`tool_name`, `tool_input.command`, patch/write inputs, `cwd`) instead of duplicating logic.
- **Git tests on Windows**: Use `.trim()` for file content assertions (CRLF vs LF); test git output for keywords, not exact strings.
- **Dev-server cleanup must be port-scoped**: Worktree agents run their own server/client ports. Never stop every `dev.mjs`, Vite, or `agentic-kanban ... src/index.ts` process by command-line pattern alone; that can kill the main board while agents are running. Use the `dev-server` skill's port-owner stop recipe for the current `$KANBAN_SERVER_PORT` / `$KANBAN_CLIENT_PORT`.
- **Dev launcher must not kill other checkouts**: `scripts/dev.mjs` may free a port only when the owning process command line belongs to the same checkout root. If a worktree is accidentally pointed at `3001`/`5173`, it must refuse to kill the main board instead of "helpfully" freeing the port.
- **Agent env separates board vs worktree ports**: In worktree agent sessions, `KANBAN_BOARD_SERVER_PORT` points at the main board API, while `KANBAN_SERVER_PORT` / `KANBAN_WORKTREE_SERVER_PORT` and `KANBAN_CLIENT_PORT` / `KANBAN_WORKTREE_CLIENT_PORT` point at that worktree's dev ports. Use board ports for kanban REST calls and worktree ports for dev-server cleanup/local visual checks; `PORT`, `SERVER_PORT`, and `VITE_PORT` are also set to the worktree ports for subprocesses.
- **`git stash` in worktrees is dangerous**: `git stash` + `git stash pop` can silently discard ALL tracked changes, leaving only untracked files. Always verify after pop: `git diff --stat HEAD`. Prefer a WIP commit (`git commit --amend`) over stashing in a worktree.
- **Invalid worktree handoff**: If a handoff path under `C:\andrena\.worktrees\...` has no `.git` file or lacks repo instructions/skills, treat it as a stale plain folder. Use the main checkout for git/history/docs and do not retry git commands in that directory.
- **Migration number collisions**: Parallel feature branches independently pick the same "next" migration number because each worktree starts from the same base. Before creating a migration, check the highest number in the **main checkout** (`C:\andrena\agentic-kanban\packages\shared\drizzle`), not the worktree — multiple branches in flight will all see the same last number. Use the kanban server's copy as ground truth.

### Git service — single source of truth
All git operations live in `packages/shared/src/lib/git-service.ts`. Both `packages/server/src/services/git.service.ts` and `packages/mcp-server/src/git-service.ts` are thin re-exports — **edit only the shared file**.

- **Detached HEAD guard in worktrees**: `syncBranchToHead()` forces branch ref to match HEAD before every merge. `ensureOnBranch()` reattaches HEAD after worktree creation and successful rebase.
- **Never `git reset --soft <branch>` in a worktree** — this can corrupt the `.git` pointer file, detaching the worktree from its branch reference and requiring a fresh worktree to recover. Use `git rebase` or `git merge` instead.
- **Conflict detection uses `git merge-tree`**: `detectConflicts()` uses `git merge-tree --write-tree --no-messages HEAD <baseBranch>` (read-only). Exit 0 = clean, exit 1 = conflicts. Parse unique filenames from staged-entry records on stdout. Never use `merge --no-commit --no-ff` — it mutates the working tree and races on concurrent requests.
- **Migration file number conflicts on rebase**: When rebasing a feature branch that added a migration, check if the target branch independently added a migration with the same sequence number (e.g., both added `0044_*.sql`). If so, rename your migration to the next available number and remove any duplicate SQL from it before pushing.
- **Direct workspace diff only shows tracked files**: `git diff HEAD` excludes untracked files. `getWorkingTreeDiff()` also runs `git ls-files --others --exclude-standard` for new files.

### In-flight workspace recovery
- **Old in-flight workspace batches**: Do not resume many stale/idle board workspaces at once. Start one workspace first, then at most two only after the server stays healthy and touched-file overlap is clear.
- **Zero-output provider sessions**: If a provider transcript shows a 1-second run with zero tokens or no assistant output, treat the board session as launch-failed/stale, stop it, and inspect/rebuild the branch instead of waiting through long polling loops.

### E2E testing
- **Always use `127.0.0.1`, never `localhost`** — on Windows, `localhost` resolves to `::1` (IPv6) but Playwright and the server listen on `127.0.0.1`. Using `localhost` causes silent ECONNREFUSED failures that are extremely hard to debug.
- **Playwright browsers are pre-installed** — do NOT run `playwright install` or `playwright install chromium` in agent sessions. The headless-shell binary is already at `%LOCALAPPDATA%\ms-playwright\chromium_headless_shell-1217\`. Running install again wastes time and may corrupt the lock file. If you see "Executable not found", check `packages/e2e/playwright.config.ts` — it auto-detects the binary path.
- **E2E locator specificity**: `page.locator("text=X")` can match multiple elements — use scoped selectors: `page.locator("label", { hasText: "X" })` or `.first()`.
- **E2E test data cleanup**: Use `test.afterAll` to reset preferences/settings state. Use `Date.now()` suffixes for edited titles — hardcoded titles accumulate across runs.
- **Pre-existing test failures**: Never dismiss as "pre-existing" without investigating root cause (data accumulation, race condition, API change). Fix if straightforward; document if not.
- **E2E session/workspace tests**: Use retry loops (3 attempts, 500ms–1s delays) for setup and output fetching instead of `test.skip()`.

### E2E Anti-Patterns

| Anti-pattern | Problem | Fix |
|---|---|---|
| `page.locator("text=X")` | Matches multiple elements → ambiguous | Use `page.locator("role", { hasText: "X" })` or `.first()` |
| Hardcoded issue/task titles | Titles accumulate across runs → false failures | Append `Date.now()` suffix so each run is unique |
| No `afterAll` / `afterEach` cleanup | State leaks between tests and runs | Use `test.afterAll` to delete created data and reset preferences |
| `localhost` in URLs/requests | On Windows resolves to `::1` (IPv6), server listens on `127.0.0.1` → silent ECONNREFUSED | Always use `127.0.0.1` |
| `test.skip()` for flaky setup | Hides real failures, silently skips coverage | Use retry loops (3 attempts, 500ms–1s delays) |
| Dismissing failures as "pre-existing" | Root cause stays unfixed (data accumulation, race, API change) | Always investigate; fix or document |
| Hardcoded port numbers | Wrong port in worktrees → connection errors | Read `$env:KANBAN_CLIENT_PORT` / `$env:KANBAN_SERVER_PORT` |

### Known Flaky Test Suites

> **Use `pnpm test:mine` to skip these.** It runs only the unit suites that are reliably green in any environment (main checkout or worktree) — the unit-tests-marked-flaky below are excluded, so it's the fast, no-false-failures loop for day-to-day iteration. Use the full `pnpm test` only before mark-ready / for CI. `--changed HEAD` passes through: `pnpm test:mine -- --changed HEAD`. (**Note**: vitest 4 removed `--related`; use `pnpm exec vitest related <file>` from inside the package instead.)

When a test in the table below fails and you haven't touched the relevant code, treat it as a **false failure** and do not waste time debugging it. Investigate only if you changed the underlying source files.

| File | Test(s) | Root Cause | Workaround |
|------|---------|-----------|-----------|
| `packages/e2e/tests/ui/board.test.ts` | "edit issue from detail panel" | Race condition: Edit panel open timing + `.first()` selector ambiguity + 10 s hard timeout | Re-run; increase timeout; use specific aria/placeholder selectors |
| `packages/e2e/tests/ui/board.test.ts` | "drag issue between columns" | `page.waitForTimeout(1000)` fixed sleep before verifying drop target | Re-run; replace with `waitForFunction()` checking board state |
| `packages/e2e/tests/ui/workspace.test.ts` | "View Diff button", "Merge button" | Backdrop overlay close uses `waitForTimeout(300)`; setup retry uses fixed 500 ms delays; setup failure silently skips | Re-run; replace fixed sleeps with `await expect(backdrop).toBeHidden()` |
| `packages/e2e/tests/ui/session-history.test.ts` | Multiple | 2-second hard sleep waiting for session completion (`setTimeout(resolve, 2000)`) | Re-run; replace with polling loop checking session `exit_code` |
| `packages/e2e/tests/ui/workspace-chat.test.ts` | Multiple | Many fixed 500 ms–1 s delays + `test.skip()` on setup failure silently hides errors | Re-run; add exponential-backoff helper; log skip reasons |
| `packages/e2e/tests/api/board-events.test.ts` | WebSocket event tests | Race condition: no wait for `readyState === 1`; 500 ms fixed delay before create; no timeout wrapper on WS promise | Re-run; wrap WS promise in `Promise.race()` with 5 s timeout |
| `packages/e2e/tests/ui/board-realtime.test.ts` | "board updates when issue created via API" | `projects[0]` access without validating array is non-empty | Re-run; use `getE2EProjectId()` helper instead |
| `packages/e2e/tests/ui/all-workspaces-panel.test.ts` | Multiple | Multiple `waitForTimeout(300)` calls + active-project state dependency across runs | Re-run; replace sleeps with condition-based waits |

| `packages/server/src/__tests__/git.service.test.ts` | All | Real filesystem + git operations; Windows file-locking on temp dirs; no per-test timeout | **Only run when touching `packages/shared/src/lib/git-service.ts`**; add `test.setTimeout(30000)`. Excluded by `pnpm test:mine`. |
| `packages/server/src/__tests__/cli.test.ts` | All | Spawn-based CLI integration test; in a worktree `packages/shared/dist` isn't built and the inline migration list is stale → `ERR_MODULE_NOT_FOUND` / "Failed query" | Pre-existing-broken in worktrees — don't debug if you didn't touch the CLI. Excluded by `pnpm test:mine`. |
| `packages/server/src/__tests__/cli-butler.test.ts` | All | Spawn-based CLI integration test; same worktree root causes as `cli.test.ts` | Pre-existing-broken in worktrees. Excluded by `pnpm test:mine`. |
| `packages/mcp-server/src/__tests__/mcp-tools.test.ts` | All | Spawn-based MCP integration test; stale inline `MIGRATION_FILES` (0000–0024 only) + worktree DB resolution → "Failed query" / missing "Default Project" | Run the in-process unit tests in `packages/mcp-server/src/__tests__/tools/` instead. Excluded by `pnpm test:mine`. |

**Recurring root causes to watch for:**
- `page.waitForTimeout()` / `setTimeout(r, N)` fixed sleeps — replace with explicit condition waits or retry loops
- `.first()` on broad selectors — use `[aria-label]`, `[placeholder]`, or scoped parent locators
- `projects[0]` array access — use `getE2EProjectId()` (reads active-project preference)
- `test.skip()` on setup failure — log the reason; prefer a clear error over a silent skip
- **Hardcoded timestamps in unit tests** — if the production code computes staleness/age against `Date.now()`, seeding tests with hardcoded ISO strings (e.g. `"2026-05-28T11:30:00.000Z"`) causes failures the next day. Use `Date.now()`-relative offsets: `new Date(Date.now() - 60 * 60 * 1000).toISOString()` (= 1h ago)

### Unit testing
- **Run vitest from the WORKTREE, not the main checkout** — new/changed test files exist only on your branch in the worktree. Running `pnpm exec vitest run src/__tests__/foo.test.ts` from `C:\andrena\agentic-kanban` (the main checkout) yields a misleading **`No test files found, exiting with code 1`** — the file simply isn't there. This is a directory mismatch, NOT a broken or missing test. (Contrast: `pnpm cli --` must run from the *main* checkout — opposite rule. Don't conflate them.) `cd <worktree>\packages\server` first.
- **`--related` is BROKEN in vitest 4** — `CACError: Unknown option '--related'`. Do not use it.
- **Board endpoint regressions usually belong in `packages/server/src/__tests__/api.test.ts`** - it runs in-process from the worktree and avoids Playwright/dev-server/node_modules setup churn. Use Playwright API E2E only when browser/client wiring or a real running server is the behavior under test.
- **For targeted runs, pass the test file pattern directly**:
  ```
  pnpm test:mine -- src/__tests__/tags.test.ts
  ```
- **For a specific source file**: use the `vitest related` subcommand (from inside the package dir):
  ```
  cd packages/server
  pnpm exec vitest related src/services/foo.service.ts
  ```
- **For all git-changed files**: use `--changed HEAD` (works through `test:mine`):
  ```
  pnpm test:mine -- --changed HEAD
  ```
- **⚠️ `pnpm test -- --related` is broken in vitest v4** — `--related` is no longer a flag of `vitest run`; it's a standalone subcommand. Use `exec vitest related` instead.
- The command-safety hook blocks `--related` flag usage; rerun with `pnpm exec vitest related <file>` or `pnpm test:mine -- --changed HEAD`.
- **Full suite** (`pnpm --filter agentic-kanban test`) should only be used before committing or when cross-cutting changes may affect unrelated tests.
- **`nowOverride` pattern for time-dependent services**: inject an optional `now?: string` parameter into any service function that calls `new Date()` for staleness/expiry logic. Tests pass `new Date().toISOString()` or a relative offset — never a hardcoded ISO string that ages out.

## TypeScript type-checking in worktrees
Worktrees do **not** have their own `node_modules` — the directory only exists in the main checkout (`C:\andrena\agentic-kanban`). Running `pnpm --filter @agentic-kanban/client exec tsc --noEmit` or `pnpm build` inside a worktree will produce `Cannot find module 'react'` / `JSX.IntrinsicElements` errors that are **not caused by your changes**. To validate your changes:
- Run `pnpm install` once in the worktree root to create symlinks, OR
- Accept that TS errors in the worktree are environment noise; verify correctness via the running dev server + Playwright instead.

**Unit/integration test anti-patterns:**

| Anti-pattern | Problem | Fix |
|---|---|---|
| Hardcoded absolute timestamps in DB seed data | Staleness/time-window checks use wall-clock time; seeded dates age past thresholds → assertions fail hours later | Use `new Date(Date.now() - N * ms).toISOString()` for any seed timestamp that participates in a time check |
| Not using `nowOverride` in time-sensitive integration tests | Service uses `new Date()` internally → results vary by when the test runs | Pass a fixed `now` to service calls: `listPendingQuestionsForProject(id, db, new Date().toISOString())` |

## Visual Verification
Every feature with UI must be visually verified using the `playwright-cli` skill.
1. Determine ports: in a worktree, use `$env:KANBAN_CLIENT_PORT` / `$env:KANBAN_SERVER_PORT` — never hardcode 3001/5173. Check if server is already listening before starting `pnpm dev`.
2. Use `/playwright-cli` to open `http://127.0.0.1:<KANBAN_CLIENT_PORT>` and confirm rendering.
3. Clean up `.png` files and `.playwright-cli/` after. Delete test issues/workspaces via MCP tools — never `pnpm db:reset`.
- **HMR lag**: After editing CSS/className files, do a hard `playwright-cli reload` and wait 5–7 s before checking computed styles. Vite HMR may not propagate before your first screenshot/eval.
- **PowerShell npm noise**: Prefix playwright-cli invocations with `$env:npm_config_loglevel="silent"` to suppress npm warnings that PowerShell treats as errors via `$LASTEXITCODE`.

## Documentation Map
- `.llm/workflows.md` — dev workflows: clean-start setup, DB reset, project registration, migration diagnosis
- `docs/prd/00-executive-summary.md` — vision, keep/skip list
- `docs/prd/05-mvp-scope.md` — MVP definition, 6-stage plan, feature matrix
- `docs/prd/03-data-model.md` — core entities (Project, Issue, Workspace, Session)
- `docs/prd/04-agent-integration.md` — MCP tools, agent lifecycle
- `docs/prd/06-testability-strategy.md` — test pyramid, per-stage test plans
- `docs/decisions/` — numbered decision records
- `docs/state.md` — current progress tracking
- `scripts/board-monitor/README.md` — the autonomous board-monitor **orchestrator** loop (how to run/stop/observe); architecture & the A/B/C choice in `docs/decisions/006-board-monitor-orchestrator-architecture.md`

## Board-Monitor Orchestrator (this dev board)
The autonomous control plane that keeps **this** board moving (server alive, merge finished work, unstick stale sessions, refill backlog) is **`scripts/board-monitor/`** — a fresh short-lived `codex exec` session every ~5 min (`loop.sh` + `objective.md`), **not** one long-running agent and **not** the in-process app monitor. Durable memory lives outside the model: board + git + a bounded, gitignored rolling `state.md` (last ~40 cycles), so each run is disposable and crash-resilient. This is our **dogfooding** choice; the shipped app default for other projects is the in-process monitor (`runMonitorCycle`). Rationale and the measured A/B/C tradeoff: `docs/decisions/006-board-monitor-orchestrator-architecture.md`. The `board-monitor` **skill** (`.claude/skills/board-monitor/`) is the system-level health checklist a run invokes — the loop is the harness.

**`objective.md` is the SINGLE SOURCE OF TRUTH for monitor policy** — including its **TUNABLE TARGETS** block (`ACTIVE_AGENTS_TARGET`, `BACKLOG_FLOOR`, `MAX_NEW_STARTS_PER_CYCLE`). Both monitor mechanisms read this one file: the codex loop, and the in-process **Monitor Butler** (`packages/server/src/services/monitor-butler.ts`, `monitor_butler_enabled`, off by default) whose `STRATEGY_FILE` points at it. There is intentionally **no** `.claude/monitor-strategy.md` — don't recreate one; edit `objective.md` to steer either mechanism. `loop.sh` **re-reads `objective.md` at the start of every iteration**, so policy/target edits take effect on the next cycle with **no restart** — only changes to `loop.sh` itself (or its env knobs) need a loop restart.

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

> **Don't hand-roll `curl ... | python -c "import json"` from the Bash tool.** Reach for the `mcp__agentic-kanban__*` tools first (they return parsed JSON directly), and only when no MCP/CLI equivalent exists, query REST from the **PowerShell tool** with `Invoke-RestMethod` (auto-parses JSON). Shelling out to `curl | python` for API+JSON work is brittle on Windows and burns turns — see [[feedback_powershell_http]].

### `#N` means kanban issue, not GitHub PR

When the user references `#N` (e.g., "review #70", "merge #65", "what's the status of #72"), this **always refers to a kanban board issue number**, never a GitHub pull request.

### Common tasks → exact commands

| User says | CLI command | REST equivalent |
|---|---|---|
| "board state" / "what's happening" | `pnpm cli -- status` | `GET /api/projects/:id/board` |
| "status of #N" / "what's #N doing" | `pnpm cli -- issue status <N>` | `GET /api/issues/:id/workspaces` + sessions |
| "resume #N" / "restart #N" | `pnpm cli -- workspace resume <N>` | `POST /api/workspaces/:id/launch` |
| "review #N" | — | `POST /api/workspaces/:id/review` |
| "merge #N" | MCP `merge_workspace` | `POST /api/workspaces/:id/merge` |
| "move #N to Done" | `pnpm cli -- issue move <N> Done` | MCP `move_issue` |

**Important:** "resume #N" means relaunch the agent on issue #N's workspace. Use `pnpm cli -- workspace resume <N>`. Do NOT investigate the code yourself or spawn sub-agents to do the work.

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
| Advance an issue's workflow state (e.g., to Review) | MCP `mcp__agentic-kanban__propose_transition` | `POST /api/workflows/workspaces/:id/transition` (note: NOT `/api/workspaces/:id/propose-transition` — that path returns 404) |

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

Avoid unbounded `list_workspaces` for narrow questions like "open issues" or "what can merge?" — it can return every historical workspace and blow the tool output budget. Use `list_issues` / `get_board_status`, or a status-specific CLI/API query, then inspect individual workspaces only as needed.

**Use the CLI (`pnpm cli -- ...`) when MCP is unavailable:**
- `pnpm cli -- issue list/create/move`
- `pnpm cli -- issue status <N>` — single-issue deep dive: workspace state, session info, last agent message. Prefer over `issue get` for state checks.
- `pnpm cli -- workspace list/create`
- `pnpm cli -- workspace resume <N>` — relaunch agent on issue #N's workspace (looks up by issue number)
- `pnpm cli -- skill list/get/create/export`
- `pnpm cli -- status` — board overview with last agent message per issue

**Note:** `--json` and other flags (`--help`, `-d`, …) now work through `pnpm cli --`. The wrapper's leading `--` (which commander treated as end-of-options, so flags became positional operands) is stripped in `cli/index.ts`. REST API JSON output remains available as an alternative.

**Note:** `pnpm cli -- <any command>` fails in git worktrees with `ERR_MODULE_NOT_FOUND` because `packages/shared/dist` is not built in the worktree. Use the main checkout CLI (`cd C:\andrena\agentic-kanban && pnpm cli -- ...`) or MCP tools / REST API instead.
The command-safety hook blocks direct `pnpm cli --` from worktrees; switch to the main checkout, MCP, or REST instead of retrying.

**Only fall back to REST API** when no MCP tool or CLI equivalent exists.

### Ask the Butler

The **Butler** is a warm, per-project Claude assistant (Agent SDK, in-process) — distinct from the per-task workspace agents. Users reach it in the UI via the **Butler** view (press `i`); it can answer project/board questions and orchestrate board work (it launches via `POST /api/workspaces`, never the bare `start_workspace`). For a one-shot question without the UI: MCP `ask_butler` (`{ projectId, question }`) or `pnpm cli -- butler ask "<question>"`. Implementation/ops detail: `packages/server/CLAUDE.md` ("Butler" section); architecture rationale: `docs/decisions/003-butler-architecture-agent-sdk-vs-cli.md`.

**Multiple butlers:** you can keep several named butlers warm at once (e.g. a "Smart"/opus and a "Quick"/haiku), each with its own model and conversation context. Definitions are **global** (shared across projects, capped at 4) — manage them via the gear next to the butler switcher in the Butler view, or `GET/POST/PUT/DELETE /api/butler-definitions`. Select one with the `?butler=<id>` query param (REST), `--butler <id>` (CLI), or the `butler` arg (MCP `ask_butler`); omitting it targets the always-present `default` butler. List them: `pnpm cli -- butler list`.

## Monorepo Commands
- `pnpm dev` — start server + client (auto-detects worktree ports; default: server 3001, client 5173)
- `pnpm dev:desktop` — start server + client + Tauri native window
- `pnpm test:mine` — **fast iteration loop**: runs only reliably-green unit suites (server + mcp-server), skipping the known-flaky ones (see "Known Flaky Test Suites"). Use this while iterating; run the full suite once before mark-ready. `--changed HEAD` passes through: `pnpm test:mine -- --changed HEAD`; to filter, pass a test file pattern directly, e.g. `pnpm test:mine -- tags.test.ts`.
- `pnpm --filter agentic-kanban test` — Vitest unit tests (full suite — server package only)
- **targeted by source file** (vitest 4): `cd packages/server && pnpm exec vitest related src/services/foo.service.ts`
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
- **Never poll with `Get-NetTCPConnection` in a loop** — each iteration spawns a terminal window on Windows.

**CRITICAL: Never kill ALL node processes.**

**Starting the dev server** — two steps, no polling:
```bash
# Step 1 — Bash tool: launch and detach
nohup pnpm dev > /tmp/kanban-dev.log 2>&1 &
disown
echo "Started PID: $!"
```
```powershell
# Step 2 — PowerShell tool (run_in_background: true): single fixed delay then one HTTP check
Start-Sleep -Seconds 15
try { $r = Invoke-RestMethod "http://127.0.0.1:3001/api/projects" -TimeoutSec 10; Write-Host "API OK: $($r.Count) projects" } catch { Write-Host "API FAILED: $_" }
```
- Use `nohup` + `disown` so the process survives the Bash session exit (plain `&` gets SIGHUP).
- Do NOT use `Start-Job` — when PowerShell exits, the job and its children die.

**Stopping the dev server** — kill by process signature (catches main + dangling worktree servers):
```powershell
Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -like "*dev.mjs*" } |
    ForEach-Object { taskkill /F /T /PID $_.ProcessId 2>$null }
Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like "*vite/bin/vite.js*" } |
    ForEach-Object { taskkill /F /T /PID $_.ProcessId 2>$null }
Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -like "*agentic-kanban*tsx*src/index*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
```
Also kill orphaned tsx server processes — they hold the SQLite DB open, causing `/api/projects` to hang even when `/health` responds.

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

- **Built-in skills** (`isBuiltin: true`, seeded by `pnpm db:seed`): `board-navigator`, `code-review`, `code-review-thorough`, `dependency-analyzer`, `ticket-enhancer`, `orchestrator`, `monitor-nudge`, `kanban-workflow`. Cannot be modified/deleted via API. These are project-generic — useful for any git repo using the kanban board.
- **Custom skills**: Created via API/CLI/MCP. Support optional `projectId` scoping.
- **Review prompt**: Uses built-in `code-review` skill. Create a project-scoped `code-review` skill to override. Supports `{{branch}}`, `{{baseBranch}}`, `{{issueId}}`, `{{autoFixInstructions}}` placeholders.
- **API**: `GET/POST/PUT/DELETE /api/agent-skills`. `GET ?projectId=<id>` returns global + project-specific.
- **MCP**: `list_agent_skills`, `get_agent_skill`, `create_agent_skill`, `export_agent_skills`.

### Built-in vs project-specific skills

**Built-in skills** (in `packages/server/src/builtin-skills.ts`) are shipped with the app and installed via `npx agentic-kanban install-skill .`. They are generic — useful for any user's git repo (e.g. `kanban-workflow`, `code-review`, `board-navigator`).

**Project-specific skills** live only in `.claude/skills/` on disk in this repo. They are NOT shipped with the npm package. These are for developing agentic-kanban itself (e.g. `publish`, `cleanup`, `session-inspector`, `board-monitor`, `ui-explorer`, `architecture-improvement`). Do NOT add project-specific skills to `builtin-skills.ts`.
