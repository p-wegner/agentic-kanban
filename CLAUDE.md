# CLAUDE.md

Operational detail lives in skills (see Skill Map). When a task matches a skill, invoke it — don't re-derive its steps here.

## What This Is
Cleanroom reimplementation of [vibe-kanban](https://github.com/BloopAI/vibe-kanban): a kanban board for AI-driven coding tasks. Personal, single-user, local-first. TypeScript monorepo: Hono + Drizzle + React + MCP SDK + Tauri v2. Stages 0–13 done. Progress: `docs/state.md`.

Active project is "agentic-kanban" — use it for all monitor/workspace/MCP operations. On startup `deduplicateProjects()` removes legacy duplicates; if two show for one repo, restart the server.

## Hard Constraints — never violate
- **Never delete/wipe `kanban.db`** (no `pnpm db:reset`, no `rm`/`Remove-Item`/truncate/`Out-File`/redirect, any path form incl. `/mnt/c/...`). Delete individual issues/workspaces via MCP/API. The `validate-command-safety.js` PreToolUse guard blocks this — when it fires, STOP and ask the user; never weaken or route around it. For migration/lock/WAL problems use the `db-doctor` skill (`pnpm db:repair`, never deletes).
- **Never kill ALL node processes; never use `Start-Process`; never poll ports in a loop** — they flash terminal windows and kill other agents' worktree servers. Run headless; spawn Node with `windowsHide: true`. See `dev-server` skill.
- **Always commit** after finishing a task, unprompted. PR creation skipped — manual merge only.
- **Local only** — no cloud/multi-tenant/OAuth. Windows; use `uv`/`uv venv` for Python.
- **`#N` always means a kanban issue number, never a GitHub PR.**

## Scope Discipline
Change only what the task requires. Don't fix unrelated issues, rename/reformat out of scope, or add features while refactoring. File a kanban ticket (`mcp__agentic-kanban__create_issue`) for unrelated issues instead of fixing inline. Run `scope-guard` before committing (creep signal: >3–4 files for a small task, or files unrelated to the ticket).

## Agent Providers
Claude Code, Codex, Copilot — selectable via Settings → Agent. Claude reads `~/.claude/settings_*.json`, Codex `~/.codex/<name>.config.toml`, Copilot the CLI default or a configured model profile.

**Provider default — single source of truth = the Strategy Bullseye pref (`board_strategy_<projectId>`).** It fans out to all consumers: `selectProviderFromStrategy` → `POST /api/workspaces` default, `resolveMonitorTunables` (deterministic monitor), and a regenerated `objective.md` (the Conductor agent). Two values sit *outside* that fan-out and drift if set independently — the `provider`/`claude_profile` settings prefs (butler/review/UI) and the global `default_model` (applied to BOTH providers; a cross-provider model id breaks the other — this drift caused a multi-cycle stall). **To change the default, use the `set-provider-default` skill** — it sets the Bullseye, mirrors the settings prefs, scopes/clears `default_model`, and verifies all agree. Never hand-edit one source alone. (The code-level fix to collapse these is tracked on the board.)

## Board Operations
Tool precedence: **MCP** (`mcp__agentic-kanban__*`) → **CLI** (`pnpm cli -- ...`) → **REST**. Use the board's own features — review (`POST /api/workspaces/:id/review`), merge (`merge_workspace`), fix-and-merge, rebase (`update-base`), enhance, dependency-analyze — don't replicate manually. For narrow questions use `list_issues`/`get_board_status`, not unbounded `list_workspaces`. Don't hand-roll `curl | python`.

- Read a ticket: `pnpm cli -- issue get <N>` (`--json` for JSON).
- "resume #N" = `pnpm cli -- workspace resume <N>` (relaunch agent), not manual investigation.
- `board-navigator` + `kanban-workflow` skills = full tool/command/workflow reference.
- **Butler** = warm per-project assistant (press `i`, MCP `ask_butler`, or `pnpm cli -- butler ask`).

## Architecture Patterns

### Git service — single source of truth
All git ops in `packages/shared/src/lib/git-service.ts`; `server/src/services/git.service.ts` and `mcp-server/src/git-service.ts` are thin re-exports — **edit only the shared file**. Invariants: `syncBranchToHead()`/`ensureOnBranch()` guard detached HEAD in worktrees; **never `git reset --soft <branch>` in a worktree** (corrupts `.git`); `detectConflicts()` uses read-only `git merge-tree`; `getWorkingTreeDiff()` also lists untracked files (`git ls-files --others`).

### Windows / hooks
- **Hook commands in `settings.json`**: forward slashes (`\\` → `MODULE_NOT_FOUND`); relative paths fail on CWD shift; `$CLAUDE_PROJECT_DIR` not expanded.
- **Codex hook parity**: `.codex/hooks.json` routes shell checks through `.claude/hooks/smart-hooks-runner.js`, patch/write through `prevent-cross-worktree-writes.js`. New Claude safety hooks must also handle Codex input (`tool_name`, `tool_input.command`, patch/write, `cwd`).
- **Git tests**: `.trim()` content assertions (CRLF vs LF); assert on keywords, not exact strings.

### PowerShell (worst-failing tool, ~17% of calls)
- **Never name a variable `$pid`/`$host`/`$home`/`$true`/`$null`/`$pshome`** — read-only automatics; assigning throws and silently keeps the built-in (REST hits the WRONG id). Use `$procId`/`$projectId`. (Blocked by `validate-command-safety`.)
- **Don't pipe native-exe stderr with `2>&1`** — PS 5.1 wraps lines as ErrorRecords and flips `$?`/exit to failure on success. stderr is already captured.
- **Prefer `try { ... -ErrorAction Stop } catch {}`** over blanket `$ErrorActionPreference='SilentlyContinue'` (latter hides the error but still exits 1).
- **API/preference *writes*: use `curl` (Bash) or an MCP tool, NOT `Invoke-RestMethod -Method Put`** — the PS body/JSON round-trip silently no-ops. Reads via `Invoke-RestMethod` are fine.
- **Don't write `$var:`** — `$var` followed by `:` parses as a drive ref. Use `"${i}:"`.
- PS 5.1: no `&&`/`||`/ternary/`??`; default UTF-16 (pass `-Encoding utf8`); no Unix `head`/`tail`/`which`/`touch`/`grep` (use Read/Grep/Glob).

### Worktrees (read before testing/typechecking in one)
- **No `node_modules`** — `tsc --noEmit`/`pnpm build` give bogus `Cannot find module 'react'`/JSX errors. Validate via dev server + Playwright, or `pnpm install` once in the worktree.
- **Run vitest FROM the worktree** (new test files exist only on your branch). **Opposite for `pnpm cli --`: run from the MAIN checkout** (worktrees lack `packages/shared/dist`; use MCP/REST instead). `--related` broken in vitest 4 — use `pnpm exec vitest related <file>` from the package, or `pnpm test:mine -- --changed HEAD`.
- **Migration number collisions**: parallel branches pick the same next number. Check the highest in the **main checkout** `packages/shared/drizzle` first, and add new migrations to `packages/server/src/__tests__/helpers/migrations.ts` or tests won't see new tables.
- **`git stash` is dangerous** — can silently drop tracked changes. Verify `git diff --stat HEAD`; prefer a WIP commit.

### Time-dependent tests
Inject optional `now?: string` (`nowOverride`) into any service calling `new Date()` for staleness/expiry; seed timestamps as `new Date(Date.now() - N).toISOString()`, never hardcoded ISO strings that age out.

### In-flight workspace recovery
Don't resume many stale workspaces at once — one, then at most two more once healthy. A transcript showing ~1 s with zero tokens = launch-failed/stale; stop it and rebuild the branch.

## Agent Roles
Shared vocabulary; each maps to one mechanism — don't conflate.

| Name | Role | Mechanism | Trigger |
|---|---|---|---|
| **Conductor** | Out-of-process orchestrator driving THIS board (merge/unstick/start/refill) | `scripts/board-monitor/loop.sh` + `objective.md`; fresh session each ~30-min cycle | `nohup bash scripts/board-monitor/loop.sh` |
| **Autopilot** | In-process deterministic monitor (default for *other* projects; off here) | `runMonitorCycle`, `auto_monitor` pref | Settings → Workflow → Board Monitoring |
| **Steward** | In-process LLM monitor (off by default; reads `objective.md`) | `monitor-butler.ts`, `monitor_butler_enabled` | the `monitor_butler_enabled` pref |
| **Builder** | Per-ticket implementer in a worktree | `POST /api/workspaces` → agent in a worktree | New Workspace / Conductor |
| **Butler** | Warm conversational per-project assistant | Claude Agent SDK, in-process, one warm session/project | Butler view (`i`), `ask_butler`, `pnpm cli -- butler ask` |
| **Sentinel** | Human-side watch — polls Conductor health, reports one line, recovers only on failure | interactive Claude + `/loop` + cron | `/sentinel`, `sentinel` skill |
| **Smith** | Compounding-engineering session — analyzes past runs, forges durable improvements | `fleet-analysis`/`session-inspector`/`learning-step`/`distill-learnings` | those skills |

## Board-Monitor Orchestrator (this dev board)
The control plane for THIS board is the out-of-process loop `scripts/board-monitor/`: `loop.sh` spawns a fresh agent every ~30 min (`MONITOR_SLEEP`) reading `objective.md` (Claude unless `MONITOR_AGENT=codex`). Distinct from the in-process server monitor (off here, default elsewhere).

`objective.md` = single source of truth for monitor policy incl. its TUNABLE TARGETS block; re-read each iteration (no restart needed). The **Strategy Bullseye** UI (`board_strategy_<projectId>` pref) feeds all monitors via a generated `objective.md` block (agents) + `resolveMonitorTunables` pref read (deterministic); falls back to legacy `nudge_*` prefs. Per-cycle checklist = `board-monitor` skill; rationale = `docs/decisions/006-...md`.

> Caveat: this board's `objective.md` targets are hand-authored (no generated markers) — saving the Bullseye would clobber them. Edit one or the other deliberately.

### Driving a different project hands-off
For another project, the supported driver is the **in-process engine** (`runMonitorCycle` + auto-review/auto-merge + stranded-review reconciler) — NOT the Conductor (hard-coded to agentic-kanban) or Monitor Butler (decision 006).
- **Enable per project**: set `board_autodrive_<projectId>` = `"true"`. Opts into auto-start/relaunch even when global `auto_monitor` is off (force-disabled on boot; separate key so the reset doesn't clobber it). Scope: global on ⇒ all projects; else only auto-driven ones.
- Strategy Bullseye takes effect via the `resolveMonitorTunables` pref read, no `objective.md` needed (`writeStrategyObjective` no-ops for non-Conductor repos). Legacy fallback: WIP = `nudge_wip_limit`, `backlogFloor=3`, `maxNewStartsPerCycle=3` (staggered batches).
- Tag an issue `no-auto-start` to keep the monitor from launching it.

## Server Resilience
Agent subprocess callbacks wrapped in try/catch in `agent.service.ts`; `uncaughtException`/`unhandledRejection` log `[fatal]`; stale sessions cleaned on startup in `index.ts` after migrations. `auto_monitor` force-disabled on every boot.

## Agent Skills
Prompt templates in the `agent_skills` table, written to `.claude/skills/<name>/SKILL.md` in the worktree on creation. API: `GET/POST/PUT/DELETE /api/agent-skills` (`?projectId=` = global + project); MCP: `list/get/create/export_agent_skills`.
- **Built-in** (`packages/server/src/builtin-skills.ts`, `isBuiltin: true`, `pnpm db:seed`): `board-navigator`, `code-review`, `code-review-thorough`, `dependency-analyzer`, `ticket-enhancer`, `orchestrator`, `monitor-nudge`, `kanban-workflow`. Generic, shipped in npm.
- **Project-specific** live only in `.claude/skills/` (e.g. `publish`, `cleanup`, `session-inspector`, `board-monitor`, `dev-server`, `db-doctor`) — **do NOT add to `builtin-skills.ts`**.
- The review prompt uses built-in `code-review`; override per-project with a project-scoped `code-review` skill. Placeholders: `{{branch}}`, `{{baseBranch}}`, `{{issueId}}`, `{{autoFixInstructions}}`.

## Skill Map
| Need | Skill |
|---|---|
| Start/stop/health-check dev server | `dev-server` |
| DB migration/lock/WAL issues | `db-doctor` |
| Flaky vs real test failure | `flaky-test-triage` |
| New Playwright E2E test | `e2e-author` |
| Visually verify a UI change | `playwright-cli` |
| Scope-creep check before commit | `scope-guard` |
| Board via MCP / reflect progress | `board-navigator`, `kanban-workflow` |
| Per-cycle board health | `board-monitor` |
| Drive a stuck issue to master | `unstuck` |
| Clean up stale worktrees/sessions/artifacts | `cleanup` |
| Publish/release npm package | `publish`, `release` |
| Change directly on master | `direct-master` |

## Common Commands
- `pnpm dev` — server + client (worktree ports: main 3001/5173, `feature/<N>-…` = `3001+N`/`5173+N`). `pnpm dev:desktop` adds Tauri. Safe headless launch: `dev-server` skill.
- `pnpm test:mine` — fast loop (green unit suites; skips known-flaky). Takes `-- --changed HEAD` and patterns. Full `pnpm --filter agentic-kanban test` only before mark-ready / cross-cutting changes.
- `pnpm test:e2e` — Playwright E2E. `pnpm db:migrate && pnpm db:seed` — init DB. `pnpm cli -- register <path>`/`list`/`cleanup` — project & worktree management.

## Workspace Flow
`POST /api/workspaces` creates DB record + worktree + auto-launches the agent. Then: `/turn` (follow-up; takes `content` not `message`; 409 if busy), `GET /diff` (vs `baseBranch`), `/merge` (into `defaultBranch`), `DELETE` (cascades sessions + messages). Loop: register repo → create issue → new workspace → diff → merge.

## Documentation Map
- `.llm/workflows.md` — clean-start, DB reset, registration, migration diagnosis
- `docs/prd/` — `00` vision, `05` MVP scope/stages, `03` data model, `04` agent integration, `06` testability
- `docs/decisions/` — numbered decision records (`003` Butler, `006` board-monitor)
- `docs/state.md` — progress
- `packages/server/CLAUDE.md` — server-package detail (incl. Butler ops)
- `scripts/board-monitor/README.md` — run/stop/observe the loop
