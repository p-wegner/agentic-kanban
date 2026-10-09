# Operator reference (moved out of root CLAUDE.md, #1313)

Root `CLAUDE.md` is loaded by EVERY session, builders included, on every turn. These sections
are written for the operator / Conductor / Sentinel driving the board, not for a builder in a
worktree, so they live here (single copy — root `CLAUDE.md` links to this page and a guard test,
`claude-md-builder-budget.test.ts`, keeps them from creeping back). Builders still receive the
worktree-relevant slice of the board-feedback rule through the generated `CLAUDE.local.md`
(`buildBoardFeedbackSection`).

Read this page when you are the operator/Conductor, or when a task touches providers, board
operations, promotion, roles or skills.

## Two boards, in one paragraph
**Two boards (#1013): the one you TALK TO is not the one you EDIT.** `127.0.0.1:3001`/5173 — every `mcp__agentic-kanban__*` call, hook and `curl` — is the **stable** board: a built artifact in `../agentic-kanban-stable`, pinned to a `stable-YYYYMMDD[-N]` tag and to `~/.agentic-kanban/kanban.db`. **This** checkout is the **dev** board (`pnpm dev:devboard`, 3101/5273, own DB `~/.agentic-kanban-dev/kanban.db`), allowed to be red. Landing on master does NOT change the board you use; it goes live only via `pnpm promote`. Runbook: `docs/two-boards.md`.

Active project is "agentic-kanban" — use it for all monitor/workspace/MCP operations. On startup `deduplicateProjects()` removes legacy duplicates; if two show for one repo, restart the server.

## Board Feedback — when you hit a flaw IN THE BOARD
Never silently drop the finding. Modes: **`fix-direct`** (fix now in the main checkout, only when that collides with no other activity), **`file-ticket`** (safe default), **`file-and-drive`** (file + drive the board to fix it, e.g. mid-drive with builders running), **`gh-issue`** (consumer installs only). Resolution order: (1) packaged/`npx`/docker deployment → `gh-issue`; (2) `Board feedback mode: <mode>` in the main checkout's `CLAUDE.local.md`; (3) main checkout with no such line → ask the user, offer to record it; (4) in a **worktree** → always `file-ticket` (a worktree's `CLAUDE.local.md` is the board-generated ticket-context file, rewritten on every workspace creation — never config, never hand-edited). **Always pass `projectId` explicitly** — `create_issue` defaults to the ACTIVE project, usually not the one you mean. The worktree rendering is `buildBoardFeedbackSection` (`packages/shared/src/lib/ticket-context.ts`); keep it in sync. Detail: `docs/agent-guide/board-feedback.md`.

## Agent Providers
Claude Code, Codex, Copilot, Pi — Settings → Agent. Pi runs as `pi --mode json` with explicit `--extension <worktree>/.pi/plugin/agentic-kanban-hooks.ts` and repeated `--skill` flags; Pi 0.73.1 rejects `--approve`, do not add it; its safety hooks delegate to the existing `.claude/hooks/*.js`. **Herdr is NOT a provider** (decision 018): it hosts one in a pane; config-discovery only today.
- **Default provider = the Strategy Bullseye pref (`board_strategy_<projectId>`).** Change it only with the **`set-provider-default`** skill — never hand-edit one source (the `provider`/`claude_profile` prefs and `default_model_<provider>` drift otherwise).
- **Precedence: Bullseye = preference; roster + quota = permission and budget; auth-rotation ring = backstop.** The per-project allowlist/roster (`allowed_profiles_<id>`, `roster_<id>`; roles `pool`/`reserve`/`forbidden`) is applied LAST and outranks every selector; when nothing permitted is available the project HOLDS rather than borrowing an unlisted account, and `forbidden` is refused, never clamped. Nothing may read the raw keys outside `resolveProjectRuntimeConfig`.
- A restricted project goes remote only to a worker that **attests** the profile (#651/#1027); credentials never cross the wire.

Full model (roster roles, quota ordering, attestation): `docs/agent-guide/agent-providers.md`.

## Board Operations
Tool precedence: **MCP** (`mcp__agentic-kanban__*`) → **CLI** (`pnpm cli -- ...`) → **REST**. Use the board's own features — review (`POST /api/workspaces/:id/review`), merge (`merge_workspace`), fix-and-merge, rebase (`update-base`), enhance, dependency-analyze — don't replicate manually. For narrow questions use `list_issues`/`get_board_status`, not unbounded `list_workspaces`. Don't hand-roll `curl | python`.
- Read a ticket: `pnpm cli -- issue get <N>` (`--json`). **A program parsing `--json` output uses `node scripts/cli-json.mjs -- …` or `pnpm --silent cli`** — `pnpm run` prints a banner to stdout (#1109).
- "resume #N" = `pnpm cli -- workspace resume <N>`, not manual investigation.
- **A checkout moved on disk? RELOCATE, never unregister + re-register** (#964; the latter cascades away every issue/workspace/session): `pnpm cli -- relocate <project> <new-path> --move` (or `--prefix <old> <new>`), always `--dry-run` first.
- Backlog as one markdown file: `pnpm cli -- backlog export|import` (`docs/backlog-markdown.md`).
- **Ticket groups (#661, decision 015):** coupled tickets share one workspace; declare `coupled_with` at creation, consolidate with `propose_ticket_groups`. A few-minutes change is not its own ticket.
- `board-navigator` + `kanban-workflow` skills = full tool/command/workflow reference. **Butler** = warm per-project assistant (`i`, `ask_butler`, `pnpm cli -- butler ask`).

Start Mode, Conductor, worker fleet, bundled skills, plugins, promotion: `docs/agent-guide/board-operations.md`.

## Agent Roles
| Name | Role | Mechanism |
|---|---|---|
| **Conductor** | Out-of-process orchestrator (merge/unstick/start/refill) | `scripts/board-monitor/loop.sh` + objective; fresh session per ~30-min cycle |
| **Autopilot** | In-process deterministic monitor (off here) | `runMonitorCycle`, `auto_monitor` |
| **Steward** | In-process LLM monitor (off by default) | `monitor-butler.ts`, `monitor_butler_enabled` |
| **Builder** | Per-ticket implementer in a worktree | `POST /api/workspaces` |
| **Butler** | Warm conversational per-project assistant | Claude Agent SDK, in-process |
| **Sentinel** | Human-side watch of the Conductor | `/sentinel`, `sentinel` skill |
| **Smith** | Compounding-engineering session | `fleet-analysis`/`session-inspector`/`learning-step`/`distill-learnings` |

**This board's control plane** is `scripts/board-monitor/` (`objective.md` = monitor policy, re-read each cycle; per-cycle checklist = `board-monitor` skill; decision 006). Saving the Bullseye rewrites only the `STRATEGY_BULLSEYE_GENERATED_*` block of `objective.md`; the `## FOCUS POLICY` block below it is hand-edited. **Other projects** are driven by per-project **Start Mode** (`manual | monitor | conductor`, `resolveStartPolicy()`, decision 008); WIP is set in one place, the Bullseye's `activeAgentsTarget` (#1102); tag `no-auto-start` to keep an issue out. Worker fleet (remote compute, decision 012): `docs/worker-fleet.md`.

## Agent Skills
Prompt templates in the `agent_skills` table, written to `.claude/skills/<name>/SKILL.md` in each worktree (API `/api/agent-skills`, MCP `list/get/create/export_agent_skills`). **Built-ins** (`packages/server/src/builtin-skills.ts`) are generic and ship in npm; **project-specific skills live only in `.claude/skills/` — do NOT add them to `builtin-skills.ts`.** `session-inspector` is a gitignored junction to `claude-session-tools` (recreate it on a fresh clone). The review prompt is the built-in `code-review` (override per project). The bundled skill `packages/server/skills/agentic-kanban/` is **generated** — after adding an MCP tool or CLI command run `pnpm skill:generate` (`bundled-skill-freshness.test.ts` fails otherwise). Plugins: read `docs/plugin-development.md` first.

## Skill Map
Skills marked * are user-invoked (`/name`); an agent that needs one reads `.claude/skills/<name>/SKILL.md` directly.

| Need | Skill |
|---|---|
| Start/stop/health-check dev server | `dev-server` |
| DB migration/lock/WAL issues | `db-doctor` |
| Flaky vs real test failure | `flaky-test-triage` |
| New Playwright E2E test | `e2e-author` |
| Visually verify a UI change | `playwright-cli` |
| Scope-creep check before commit | `scope-guard` |
| Commit beside other agents in one checkout | `shared-checkout-commit` |
| Board via MCP / reflect progress | `board-navigator`, `kanban-workflow` |
| Per-cycle board health | `board-monitor` |
| Drive a stuck issue to master | `unstuck`* |
| Clean up stale worktrees/sessions/artifacts | `cleanup`* |
| Publish/release npm package | `publish`*, `release`* |
| Change directly on master | `direct-master`* |
| Tune the board along a dimension, or lab the Sentinel | `sentinel`* lab: `.claude/skills/sentinel/references/lab.md` (never on a watch wakeup) |

## Operator commands
- **`pnpm dev:devboard`** in THIS main checkout (plain `pnpm dev` here would take the stable board's ports and DB). Plain `pnpm dev` is for worktrees (`feature/<N>-…` = `3001+N`/`5173+N`). Safe headless launch: `dev-server` skill. Clean-clone blockers: `docs/install.md`.
- **`pnpm promote`** moves master to the stable board on a fresh green sweep — **`--dry-run` first, always**; `--force-sweep` only deliberately. `docs/two-boards.md` §8.
- `pnpm test:e2e`. `pnpm db:migrate && pnpm db:seed`. `pnpm cli -- register <path>`/`list`/`cleanup`.

## Workspace Flow
`POST /api/workspaces` creates DB record + worktree + launches the agent. Then `/turn` (takes `content` not `message`; 409 if busy), `GET /diff`, `/merge`, `DELETE` (cascades). Loop: register repo → create issue → new workspace → diff → merge.

## Documentation Map (extended)
- `.llm/workflows.md` — clean-start, DB reset, registration, migration diagnosis
- `docs/prd/`, `docs/state.md` — vision, scope, data model, progress
- `docs/decisions/` — numbered decision records
- `docs/integration-risk-ladder.md` — risk ladder, release-candidate model
- `docs/two-boards.md` (dev vs stable, promotion), `docs/worker-fleet.md`, `docs/terminal-tracker.md`, `docs/backlog-markdown.md`
- `packages/server/CLAUDE.md` — server-package detail (incl. Butler ops); `scripts/board-monitor/README.md`
