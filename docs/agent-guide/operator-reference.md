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
- **Watching the board:** **`pnpm cli -- status --watch`** is the full-screen console (#1421):
  workers (slots, build, RAM, heartbeat, current job), host RAM, master/rc/stable, verify
  placement, merge trains, pipeline, attention, merged today; `a` lists every open issue, `q`
  quits. `pnpm cli -- tracker` is the NARROW one (WIP, in-flight, rc/queue line), not the full
  view. Run either in a herdr pane, not a background shell.

## Hands-off: let the board build the backlog by itself
Two per-project prefs, both written with `PUT /api/preferences/settings` (body is a flat
`{key: value}` map; an unknown key is a loud 422):

```bash
P=d1c5d9c1-4897-4e1b-acc3-2aa96de04117   # agentic-kanban
curl -s -X PUT http://127.0.0.1:3001/api/preferences/settings -H 'Content-Type: application/json' \
  -d "{\"start_mode_$P\":\"monitor\",\"risk_posture_$P\":\"sprint\"}"
curl -s http://127.0.0.1:3001/api/projects/$P/delivery    # effective posture, server-resolved
```

- **`start_mode_<id>`** ∈ `manual | monitor | conductor` (decision 008). `monitor` = the
  in-process monitor auto-starts unblocked tickets up to the WIP limit. It works per project
  even though the global `auto_monitor` is reset to `false` on every boot
  (`startup-tasks.ts`); do not flip `auto_monitor` for this. `manual` is the kill switch.
- **`risk_posture_<id>`** ∈ `strict | standard | iterate | fast | sprint | flow` (decision 017,
  `risk-posture.service.ts`). Loosest = **`sprint`**: no per-ticket review, guards-only gate,
  no implement-exit check, contention off, trains up to 12, a red base files a debt ticket
  instead of blocking. `flow` still reviews every ticket. Back to the default: `standard`.
- Read every current value at once: `GET /api/preferences/settings`. A ticket tag
  `risk:<level>` overrides the posture for that one ticket.
- **Explicit per-field prefs beat the posture, silently.** After changing the posture, clear the
  leftovers or the new posture only half applies (2026-10-17: `train_max_size`=5,
  `train_max_wait_ms`=120000 and `verify_gate_strategy`=`impact` kept `sprint` at one merge in
  2 h). An empty string unsets them:
  `-d "{\"train_max_size_$P\":\"\",\"train_max_wait_ms_$P\":\"\",\"verify_gate_strategy_$P\":\"\"}"`.
  Then check `GET /delivery`: `trainSizeFromOverride:false`, `trainWindowFromPosture:true`, and
  `posture.gateTier` is the one in force.

## Risk postures: what each level sets
One table instead of reading decision 017 and its five amendments in order. Source of truth:
`postureForLevel` in `packages/server/src/services/risk-posture.service.ts`; `GET
/api/projects/<id>/delivery` shows the resolved posture with overrides applied.

| | `strict` | `standard` | `iterate` | `flow` | `fast` | `sprint` |
|---|---|---|---|---|---|---|
| Merge gate tier | `full` | `full` | `impact` | `impact`, no guard floor | `scoped` | `scoped-base-watch` (guards only) |
| Per-ticket review | thorough | standard | standard | standard | none (the train is reviewed) | none |
| Implement-exit check | full | impact | impact | impact | typecheck | none |
| Train size / wait | 1 / 0 | 1 / 0 | 1 / 0 | 1 / 0 | 8 / 20 min | 12 / 30 min |
| Merges / relaunches per cycle | 1 / 1 | 2 / 2 | 2 / 2 | 2 / 2 | 4 / 4 | 8 / 6 |
| Red base | blocks | blocks | heal ticket | reported only | allowed if known debt | debt ticket |
| Full-suite base sweep | 12 h | 12 h | 24 h | none (release candidate only) | 6 h | 24 h |
| File contention | serialize | serialize | serialize | serialize | warn | off |
| Placement | host-half | host-preferred | host-preferred | host-preferred | remote-preferred | remote-preferred |

Overrides on top of the level: ticket tag `risk:<level>` (that ticket only);
`red_base_policy_<id>` (softer only, a stricter value is ignored with a warning);
`train_max_size_<id>`, `train_max_wait_ms_<id>`, `verify_gate_strategy_<id>` (win over the level
without a warning, #1560). How the posture shapes merge trains, and what happens on red:
`docs/agent-guide/merge-trains.md`.

## Spreading work across Claude subscriptions (worker profiles)
The board picks a profile per remote session only for a project with `allowed_profiles_<id>`
(agentic-kanban lists `anth`, `andrena_team_5x`, `_2`, `_3`, `_4`): among the allowed profiles the
chosen worker ATTESTS, the lowest `usedPct5h` wins (>= 90% or a credentials problem is skipped).
A worker discovers every `~/.claude-<name>` dir holding `.credentials.json` at START;
`--profiles <csv>` filters that list (quote it under PowerShell: `--profiles 'a,b'`), and
`--profile-alias default=anth` names the plain/harness login. So to add profiles: edit the
worker's start flags, then restart it while it is IDLE (no session, no verify job; a drain kills
verify jobs, #1559; `restart` reuses the old argv, so stop + start). Check:
`GET /api/workers` → `attestedProfiles` with quota. State 2026-10-17: ao-pf38 `anth,
andrena_team_5x, _2`; desktop-stable `anth, _2, _3, _4` (`andrena_team_5x` there needs a
re-login); wsl-stable `anth` (credentials copied from the host's `~/.claude`, backups
`.credentials.json.bak-20261017`). A session under a named profile uses that dir's own Claude
config (hooks, plugins), not the worker's clean harness.

## After a host reboot
Nothing restarts by itself. In order:
1. Stable board: **`pnpm stable:start`** (restart-only, smoke-tests; `docs/two-boards.md` §2).
2. Workers ao-pf38 and desktop-stable reconnect on their own within a minute; check with
   `pnpm cli -- worker list`.
3. WSL worker `wsl-stable` lives in distro **`akw-r6`** under its own state file; start it in a
   herdr pane:
   `wsl -d akw-r6 -- bash -lc '~/.agentic-kanban/stable/bin/agentic-kanban-worker start --state-file ~/.agentic-kanban/stable/state.json'`
   (the distro's default `~/.agentic-kanban/worker-state.json` is an old dev-board pairing,
   `AO-PF69VL7N-wsl-akw-r6`; do not start that one). It shares host RAM, so it never verifies.
4. Console: `pnpm cli -- status --watch` in a second pane.

## Workspace Flow
`POST /api/workspaces` creates DB record + worktree + launches the agent. Then `/turn` (takes `content` not `message`; 409 if busy), `GET /diff`, `/merge`, `DELETE` (cascades). Loop: register repo → create issue → new workspace → diff → merge.

## Documentation Map (extended)
- `.llm/workflows.md` — clean-start, DB reset, registration, migration diagnosis
- `docs/prd/`, `docs/state.md` — vision, scope, data model, progress
- `docs/decisions/` — numbered decision records
- `docs/integration-risk-ladder.md` — risk ladder, release-candidate model
- `docs/agent-guide/merge-trains.md` — merge trains: window, assembly, gate, red strategy, the train shepherd (#1569), where to look
- `docs/two-boards.md` (dev vs stable, promotion), `docs/worker-fleet.md`, `docs/terminal-tracker.md`, `docs/backlog-markdown.md`
- `packages/server/CLAUDE.md` — server-package detail (incl. Butler ops); `scripts/board-monitor/README.md`
