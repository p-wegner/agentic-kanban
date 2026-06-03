# CLAUDE.md

Guidance for Claude Code when working in this repository.

> **Most operational detail lives in skills** (see the Skill Map below). This file keeps only the always-true constraints, the things agents get wrong repeatedly, and pointers. When a task matches a skill, invoke the skill — don't re-derive its steps from here.

## What This Is
Cleanroom reimplementation of [vibe-kanban](https://github.com/BloopAI/vibe-kanban) — a kanban board for managing AI-driven coding tasks. Personal use, single user, local-first. TypeScript monorepo: Hono + Drizzle + React + MCP SDK + Tauri v2. Stages 0–13 complete. Progress: `docs/state.md`.

The **active project** is "agentic-kanban" — always use it for monitor cycles, workspace operations, and MCP tools. (On startup `deduplicateProjects()` removes legacy duplicate projects; if you see two for the same repo, restart the server.)

## Hard Constraints — never violate
- **Never delete or wipe `kanban.db`** — no `pnpm db:reset`, no `rm`/`Remove-Item`/truncate/`Out-File`/redirect on the db file, in any path form (incl. `/mnt/c/...`). It holds vital dev entries. Delete individual issues/workspaces via MCP/API. A PreToolUse guard (`.claude/hooks/validate-command-safety.js`) blocks these — **when it fires, STOP and ask the user; never weaken or route around it.** For migration/lock/WAL problems use the **`db-doctor`** skill (`pnpm db:repair`), which never deletes.
- **Never kill ALL node processes**, and **never use `Start-Process`** or poll ports in a loop — they flash terminal windows and can kill other agents' worktree servers. Run commands headlessly; spawn Node with `windowsHide: true`. See the **`dev-server`** skill for the exact safe start/stop/health recipes.
- **Always commit** after finishing a task, without waiting to be asked. **PR creation is skipped** — manual merge only.
- **Local only** — no cloud, multi-tenant, or OAuth. Windows environment; use `uv`/`uv venv` for any Python work.

## Scope Discipline
Keep changes minimal and focused on the original task — agents tend to expand scope during refactoring; resist it. Only change what the task requires, don't fix unrelated pre-existing issues, don't rename/reformat outside scope, don't add features while refactoring. When you notice unrelated issues, **create a kanban ticket** (`mcp__agentic-kanban__create_issue`) instead of fixing inline. Run the **`scope-guard`** skill before committing — it diffs working changes vs the task and flags creep (signal: >3–4 files for a small task, or files unrelated to the ticket).

## Agent providers
Claude Code, Codex, and Copilot are supported, selectable via the Agent Profile dropdown (Settings → Agent). Claude uses `~/.claude/settings_*.json`, Codex `~/.codex/<name>.config.toml`, Copilot the CLI default or a configured model profile.

## Board Operations
**`#N` always means a kanban issue number, never a GitHub PR.** "resume #N" = relaunch the agent on #N's workspace (`pnpm cli -- workspace resume <N>`), not manual investigation.

Prefer the board's own features and tools over doing work by hand: **MCP tools** (`mcp__agentic-kanban__*`) → **CLI** (`pnpm cli -- ...`) → **REST** as fallback. Use the board to review (`POST /api/workspaces/:id/review`), merge (`merge_workspace`), fix-and-merge, rebase (`update-base`), enhance tickets, analyze dependencies — don't replicate these manually. Avoid unbounded `list_workspaces` for narrow questions; use `list_issues` / `get_board_status` first. Don't hand-roll `curl | python` for JSON — use MCP tools, or `Invoke-RestMethod` from the PowerShell tool.

The **`board-navigator`** and **`kanban-workflow`** skills are the full reference for tools, common-task→command mappings, and workflow rules. The **Butler** (warm per-project Claude assistant; press `i` in the UI, or MCP `ask_butler` / `pnpm cli -- butler ask`) answers project/board questions and orchestrates work.

To read a ticket: `pnpm cli -- issue get <N>` (uses the active project automatically; add `--json` for JSON).

## Architecture Patterns

### Git service — single source of truth
All git operations live in `packages/shared/src/lib/git-service.ts`. `packages/server/src/services/git.service.ts` and `packages/mcp-server/src/git-service.ts` are thin re-exports — **edit only the shared file**. Key invariants: `syncBranchToHead()`/`ensureOnBranch()` guard detached HEAD in worktrees; **never `git reset --soft <branch>` in a worktree** (corrupts the `.git` pointer); `detectConflicts()` uses read-only `git merge-tree` (never `merge --no-commit`); `getWorkingTreeDiff()` also lists untracked files (`git ls-files --others`).

### Windows / hooks
- **Hook commands in `settings.json`**: use **forward slashes** (`\\` is mangled → `MODULE_NOT_FOUND`); relative paths fail when CWD shifts; `$CLAUDE_PROJECT_DIR` is not expanded.
- **Codex hook parity**: `.codex/hooks.json` routes Codex `PreToolUse` shell checks through `.claude/hooks/smart-hooks-runner.js` and patch/write tools through `prevent-cross-worktree-writes.js`. New Claude safety hooks must also handle Codex hook input (`tool_name`, `tool_input.command`, patch/write, `cwd`) — don't duplicate logic.
- **Git tests on Windows**: use `.trim()` for content assertions (CRLF vs LF); test git output for keywords, not exact strings.

### PowerShell tool (top failure modes — measured)
Fleet analysis found PowerShell is the most-failing tool (~14% of calls). Avoid the recurring footguns:
- **Never name a variable `$pid`** (nor `$host`/`$home`/`$true`/`$null`/`$pshome`) — these are read-only *automatic* variables. Assigning throws and silently keeps the built-in value (so REST calls hit the WRONG id). Use `$procId` / `$projectId`. (The `validate-command-safety` hook now blocks this.)
- **Don't pipe native-exe stderr with `2>&1`** (e.g. `taskkill ... 2>&1`, `pnpm ... 2>&1`): in PS 5.1 it wraps stderr lines as ErrorRecords and flips `$?`/exit to failure even on success. stderr is already captured — just drop the `2>&1`.
- **Prefer `try { ... -ErrorAction Stop } catch {}` over a blanket `$ErrorActionPreference='SilentlyContinue'`** — the latter hides the real error yet the cmdlet still exits 1, so the failure looks mysterious.
- This is **PS 5.1** (Windows PowerShell): no `&&`/`||`, no ternary/`??`, default UTF-16 file encoding (pass `-Encoding utf8`). Unix `head`/`tail`/`which`/`touch`/`grep` don't exist — use the dedicated Read/Grep/Glob tools or PS equivalents.

### Worktrees (read before testing/typechecking in one)
- **No `node_modules`** — only the main checkout has them. `tsc --noEmit` / `pnpm build` in a worktree gives bogus `Cannot find module 'react'` / JSX errors that are **not your fault**. Validate via the running dev server + Playwright, or `pnpm install` once in the worktree.
- **Run vitest FROM the worktree** — new/changed test files exist only on your branch; running from the main checkout gives a misleading "No test files found". **Opposite rule for `pnpm cli --`: run it from the MAIN checkout** (worktrees lack `packages/shared/dist` → `ERR_MODULE_NOT_FOUND`; use MCP/REST from a worktree instead). `--related` is broken in vitest 4 — use `pnpm exec vitest related <file>` from inside the package, or `pnpm test:mine -- --changed HEAD`.
- **Migration number collisions**: parallel branches all pick the same "next" number. Before creating a migration, check the highest in the **main checkout** `packages/shared/drizzle` (server's copy = ground truth), and add new migrations to `packages/server/src/__tests__/helpers/migrations.ts` or unit tests won't see the new tables.
- **`git stash` is dangerous in worktrees** — stash+pop can silently drop all tracked changes; verify with `git diff --stat HEAD`, prefer a WIP commit.

### Time-dependent tests
Inject an optional `now?: string` (`nowOverride`) into any service that calls `new Date()` for staleness/expiry, and seed time-participating timestamps as `new Date(Date.now() - N).toISOString()` — never hardcoded ISO strings that age out and fail the next day.

### In-flight workspace recovery
Don't resume many stale/idle workspaces at once — start one, then at most two more once the server stays healthy. A provider transcript showing a ~1 s run with zero tokens/output is a launch-failed/stale session: stop it and rebuild the branch instead of polling.

## Agent Roles (the cast & DSL)

Several distinct AI roles operate on this board. Use these names as shared vocabulary ("the Conductor stalled", "spin up a Builder for #N", "run a Sentinel check", "ask the Butler", "do a Smith pass"). Each maps to one concrete mechanism — don't conflate them.

| Name | Role | Mechanism | Lifecycle | Trigger |
|---|---|---|---|---|
| **Conductor** | Out-of-process board orchestrator — the active control plane that drives THIS board (merge, unstick, start, refill) | `scripts/board-monitor/loop.sh` + `objective.md`; fresh Claude/codex session each cycle | long-lived loop, ~30-min cycles | `nohup bash scripts/board-monitor/loop.sh` |
| **Autopilot** | In-process **deterministic** monitor (shipped default for *other* projects; off here) | `runMonitorCycle`, `auto_monitor` pref | runs inside the server process | Settings → Workflow → Board Monitoring |
| **Steward** | In-process **LLM** monitor (off by default; reads the same `objective.md`) | `monitor-butler.ts`, `monitor_butler_enabled` | runs inside the server process | the `monitor_butler_enabled` pref |
| **Builder** | Per-ticket implementer working in a git worktree (writes the actual code) | `POST /api/workspaces` → Claude/codex/copilot in a worktree | per-task, disposable | New Workspace / Conductor starts it |
| **Butler** | Warm, conversational per-project assistant; answers questions & can orchestrate board work | Claude Agent SDK, in-process, one warm session per project | persistent per project | Butler view (`i`), `ask_butler`, `pnpm cli -- butler ask` |
| **Sentinel** | The human-side **watch** — polls the Conductor's health each cycle, reports one line, alerts+recovers only on failure. Does NOT drive the board | interactive Claude session + `/loop` + cron | session-scoped | `/sentinel` (or `/loop 30m /sentinel`) — see the `sentinel` skill |
| **Smith** | **Compounding-engineering** session — analyzes the fleet of past agent runs and forges durable improvements (skills, hooks, helper scripts, deterministic board changes, doc edits) | interactive Claude session + `fleet-analysis` / `session-inspector` / `learning-step` / `distill-learnings` | ad-hoc, session-scoped | those skills |

The three monitors (**Conductor / Autopilot / Steward**) are detailed below; the **Sentinel** poll checklist + recovery playbook lives in the `sentinel` skill; **Smith** tooling is the `fleet-analysis` family.

## Board-Monitor Orchestrator (this dev board)
The control plane that keeps **this** board moving is the **out-of-process loop** `scripts/board-monitor/` — `loop.sh` spawns a fresh short-lived agent session every ~30 min (`MONITOR_SLEEP`), each reading `objective.md`, running Claude Code unless `MONITOR_AGENT=codex`. This is distinct from the **in-process monitor** inside the server (deterministic `runMonitorCycle` + LLM Monitor Butler), which is off by default on this board but is the shipped default for other projects.

`objective.md` is the **single source of truth for monitor policy**, including its TUNABLE TARGETS block; `loop.sh` re-reads it each iteration (target edits need no restart). The **Strategy Bullseye** UI (`board_strategy_<projectId>` pref) feeds all monitors via two channels: a generated `objective.md` block (for agent-driven mechanisms) and a direct pref read via `resolveMonitorTunables` (for deterministic `runMonitorCycle`); it falls back to legacy `nudge_*` prefs when unset. The **`board-monitor`** skill is the per-cycle health checklist; architecture rationale and the A/B/C tradeoff are in `docs/decisions/006-board-monitor-orchestrator-architecture.md`.

> Caveat: this board's `objective.md` targets are currently **hand-authored** (no generated markers) — saving the Bullseye would clobber that region. Edit one or the other deliberately.

## Server resilience
Agent subprocess callbacks are wrapped in try/catch in `agent.service.ts`; `uncaughtException`/`unhandledRejection` log with a `[fatal]` prefix; stale sessions are cleaned up on startup in `index.ts` after migrations. `auto_monitor` is force-disabled on every boot.

## Agent Skills
Skills are prompt templates in the `agent_skills` DB table, written as `.claude/skills/<name>/SKILL.md` into the worktree on workspace creation. API: `GET/POST/PUT/DELETE /api/agent-skills` (`?projectId=` returns global + project-specific); MCP: `list/get/create/export_agent_skills`.
- **Built-in skills** (`packages/server/src/builtin-skills.ts`, `isBuiltin: true`, seeded by `pnpm db:seed`) are generic and shipped with the npm package: `board-navigator`, `code-review`, `code-review-thorough`, `dependency-analyzer`, `ticket-enhancer`, `orchestrator`, `monitor-nudge`, `kanban-workflow`.
- **Project-specific skills** live only in `.claude/skills/` here and are for developing agentic-kanban itself (e.g. `publish`, `cleanup`, `session-inspector`, `board-monitor`, `dev-server`, `db-doctor`). **Do NOT add these to `builtin-skills.ts`.**
- The **review prompt** uses the built-in `code-review` skill; override per-project by creating a project-scoped `code-review` skill. Placeholders: `{{branch}}`, `{{baseBranch}}`, `{{issueId}}`, `{{autoFixInstructions}}`.

## Skill Map — reach for these instead of improvising
| When you need to… | Skill |
|---|---|
| Start/stop/health-check the dev server (ports, safe kills) | `dev-server` |
| Diagnose DB migration/lock/WAL issues | `db-doctor` |
| Decide if a failing test is flaky vs a real regression | `flaky-test-triage` |
| Write a new Playwright E2E test (anti-flake from day one) | `e2e-author` |
| Visually verify a UI change | `playwright-cli` |
| Check for scope creep before committing | `scope-guard` |
| Interact with the board via MCP / reflect progress | `board-navigator`, `kanban-workflow` |
| Run the per-cycle board health check | `board-monitor` |
| Drive a stuck issue to master | `unstuck` |
| Clean up stale worktrees / sessions / E2E artifacts | `cleanup` |
| Publish / release the npm package | `publish`, `release` |
| Make a change directly on master | `direct-master` |

## Common Commands
- `pnpm dev` — server + client (auto-detects worktree ports: main = 3001/5173; `feature/<N>-…` = `3001+N`/`5173+N`). `pnpm dev:desktop` adds the Tauri window. See `dev-server` skill for the safe headless launch.
- `pnpm test:mine` — fast iteration loop (reliably-green unit suites only; skips known-flaky). Passes through `-- --changed HEAD` and test-file patterns. Run the full `pnpm --filter agentic-kanban test` only before mark-ready / for cross-cutting changes.
- `pnpm test:e2e` — Playwright E2E. `pnpm db:migrate && pnpm db:seed` — init DB. `pnpm cli -- register <path>` / `list` / `cleanup` — project & worktree management.

## Workspace Flow
`POST /api/workspaces` (one step) creates the DB record + worktree + auto-launches the agent. Then: `/turn` (follow-up message, takes `content` not `message`; 409 if busy), `GET /diff` (vs `baseBranch`), `/merge` (into `defaultBranch`), `DELETE` (cascade-deletes sessions + messages). Core loop: register repo → create issue → new workspace → view diff → merge.

## Documentation Map
- `.llm/workflows.md` — dev workflows: clean-start, DB reset, project registration, migration diagnosis
- `docs/prd/` — `00` vision/keep-skip, `05` MVP scope & stage plan, `03` data model, `04` agent integration, `06` testability strategy
- `docs/decisions/` — numbered decision records (e.g. `003` Butler, `006` board-monitor architecture)
- `docs/state.md` — current progress
- `packages/server/CLAUDE.md` — server-package detail (incl. Butler ops)
- `scripts/board-monitor/README.md` — how to run/stop/observe the orchestrator loop
