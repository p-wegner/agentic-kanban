# CLAUDE.md

Operational detail lives in skills (see Skill Map) and in `docs/agent-guide/` (the rationale,
incidents and full detail behind every rule here). When a task matches a skill, invoke it — don't
re-derive its steps. When you work in an area below, read its linked guide page first.

## What This Is
Cleanroom reimplementation of [vibe-kanban](https://github.com/BloopAI/vibe-kanban): a kanban board for AI-driven coding tasks. Personal, single-user, local-first. TypeScript monorepo: Hono + Drizzle + React + MCP SDK + Tauri v2. Stages 0–13 done. Progress: `docs/state.md`.

Active project is "agentic-kanban" — use it for all monitor/workspace/MCP operations. On startup `deduplicateProjects()` removes legacy duplicates; if two show for one repo, restart the server.

**Two boards (#1013): the one you TALK TO is not the one you EDIT.** `127.0.0.1:3001`/5173 — every `mcp__agentic-kanban__*` call, hook and `curl` — is the **stable** board: a built artifact in `../agentic-kanban-stable`, pinned to a `stable-YYYYMMDD[-N]` tag and to `~/.agentic-kanban/kanban.db`. **This** checkout is the **dev** board (`pnpm dev:devboard`, 3101/5273, own DB `~/.agentic-kanban-dev/kanban.db`), allowed to be red. Landing on master does NOT change the board you use; it goes live only via `pnpm promote`. Runbook: `docs/two-boards.md`.

## Hard Constraints — never violate
- **Never delete/wipe `kanban.db`** (no `pnpm db:reset`, no `rm`/`Remove-Item`/truncate/`Out-File`/redirect, any path form incl. `/mnt/c/...`). Delete individual issues/workspaces via MCP/API. The `validate-command-safety.js` PreToolUse guard blocks this — when it fires, STOP and ask the user; never weaken or route around it. For migration/lock/WAL problems use the `db-doctor` skill (`pnpm db:repair`, never deletes).
- **Never kill ALL node processes; never use `Start-Process`; never poll ports in a loop** — they flash terminal windows and kill other agents' worktree servers. Run headless; spawn Node with `windowsHide: true`. See `dev-server` skill.
- **Always commit** after finishing a task, unprompted. PR creation skipped — manual merge only.
- **Local only** — no cloud/multi-tenant/OAuth. Windows; use `uv`/`uv venv` for Python.
- **`#N` always means a kanban issue number, never a GitHub PR.**

## Scope Discipline
Change only what the task requires. Don't fix unrelated issues, rename/reformat out of scope, or add features while refactoring. File a kanban ticket (`mcp__agentic-kanban__create_issue`) for unrelated issues instead of fixing inline. Run `scope-guard` before committing (creep signal: >3–4 files for a small task, or files unrelated to the ticket). For narrow tickets that name the expected files, compare the staged file list to that scope and treat unrelated deletions as a blocker before commit.

**A partial refactor ("batch 1 of N", "N remain") needs a disclosure channel (#691)** before it merges: a shrink-only ratchet test for the remainder (pattern: `packages/shared/__tests__/wire-dto-single-declaration.test.ts`) **or** a follow-up ticket naming exactly what remains — plus the true state in `CONTINUE.md`. Neither is acceptable, however correct the batch.

**Several agents in ONE checkout: commit by pathspec, never via the shared index** — `git commit -F msg.txt -- <paths>`; never `git add -A`/`-a`/`.`; on `index.lock` wait and retry, never `git reset`. When another agent has uncommitted edits in a file you also changed, or after a private-index commit, use the **`shared-checkout-commit`** skill (private index + CAS `update-ref`, main checkout only). A worktree/builder/reviewer session **never writes the base ref** (`update-ref refs/heads/master`, `branch -f master`, `push … master`, `checkout master`): it rebases its own branch and lets the board land it (#1237, hard-blocked under `KANBAN_WORKTREE_DIR`).

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

## Architecture Rules
- **Git:** high-level ops only in `packages/shared/src/lib/git-service.ts` (server/mcp copies are re-exports). **Spawn git only via `packages/shared/src/lib/git-exec.ts`** (`gitExec`/`gitExecOrThrow`/`gitExecSync`, deep import, node-only) — never a private `execGit`/`execFile("git")` (`git-exec-single-spawn.test.ts`). **Never `git reset --soft <branch>` in a worktree**; no `--no-edit` on `git rebase`.
- **Pre-merge gate** (`pre-merge-gate.service.ts`): a suite that reads state outside its import graph (spawns a script, reads `MIGRATIONS_DIR`, walks a tree) carries `// @gate:always-run` (optionally `when:<globs>`); `always-run-marker-ratchet.test.ts` enforces it. Gate tiers (`verify_gate_strategy_<id>`) only weaken VISIBLY; `impact` is opt-in, never a default. Read `docs/agent-guide/pre-merge-gate.md` before touching the gate, the markers or `test-mine.mjs`.
- **Vite binds wide but the API does not** (#866): `devProxyGuard.ts` rejects non-loopback `/api`/`/health`/`/ws`. Never `KANBAN_HOST=0.0.0.0`.
- **A builder writes ONLY in its own worktree** (#959) — any other repo is hard-blocked; if a card needs a change elsewhere, file a ticket against that project.
- **Commit messages: no UTF-8 BOM** (#976) — write the `-F` file with Bash, never a PowerShell redirect.
- **Time-dependent code:** inject `now?: string` (ISO, persisted) or `nowMs?: number` (arithmetic) — no other spelling (`time-injection-spelling-ratchet.test.ts`); seed test timestamps relative to `Date.now()`, never hardcoded ISO.
- **Hooks:** `settings.json` hook commands use forward slashes and `${CLAUDE_PROJECT_DIR}/`-prefixed paths (braced: headless sessions run hooks through PowerShell, where the bare form is empty and the guard fails open, #1311). New Claude safety hooks must also handle Codex input (`.codex/hooks.json`; `tool_name`, `tool_input.command`, patch/write, `cwd`). Git tests: `.trim()` and assert keywords, not exact strings.
- **Resilience:** agent subprocess callbacks are try/catch'd in `agent.service.ts`; `auto_monitor` is force-disabled on every boot.

Detail and incidents: `docs/agent-guide/architecture-notes.md`.

### PowerShell (worst-failing tool)
Never assign `$pid`/`$host`/`$home`/`$true`/`$null`/`$pshome` (use `$procId`/`$projectId`). No `2>&1` on native exes. Prefer `try { … -ErrorAction Stop } catch {}`. API/preference **writes** via `curl` (Bash) or MCP, never `Invoke-RestMethod -Method Put`. Write `"${i}:"`, not `$i:`. PS 5.1: no `&&`/`||`/ternary/`??`; pass `-Encoding utf8`.

### Worktrees
- Worktrees get a real `pnpm install -r`, so test/typecheck/`pnpm install` **in the worktree** is safe. Exception: a worktree created while Dependency Symlinks was ON holds junctions into main — never `pnpm install`/`add` there; recreate it.
- **Run vitest FROM the worktree; run `pnpm cli --` from the MAIN checkout** (or use MCP/REST). vitest 4 has no related flag: `pnpm exec vitest related <file>` or `pnpm test:mine -- --changed HEAD`.
- **Migration numbers:** check the highest in the main checkout's `packages/shared/drizzle`; add a `_journal.json` entry (the test list is journal-derived).
- **`git stash` can drop tracked changes** — prefer a WIP commit.
- **Nested worktrees (`<main>/.claude/worktrees/*`) get NO `pnpm install` and NO `pnpm dev`** (#1033); put checkouts that need deps in the sibling `.worktrees/` layout and remove dirs with `node scripts/safe-rmdir.mjs <dir>`. If main's `node_modules` links vanish: `pnpm install -r --offline` in main.
- **Recovery:** resume one stale workspace at a time (then at most two more). A ~1 s transcript with zero tokens = launch failed; stop it and rebuild the branch.

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

## Common Commands
- **`pnpm dev:devboard`** in THIS main checkout (plain `pnpm dev` here would take the stable board's ports and DB). Plain `pnpm dev` is for worktrees (`feature/<N>-…` = `3001+N`/`5173+N`). Safe headless launch: `dev-server` skill. Clean-clone blockers: `docs/install.md`.
- **`pnpm promote`** moves master to the stable board on a fresh green sweep — **`--dry-run` first, always**; `--force-sweep` only deliberately. `docs/two-boards.md` §8.
- **Inner loop:** `[ -f .claude/skills/test-impact/tools/impact.mjs ] && node .claude/skills/test-impact/tools/impact.mjs select --min-score 1.0 --format vitest`, then run what it prints — **`select`, never `build`**. A green selection is not a green gate.
- **`pnpm test:mine` is the gate** — run it (and `pnpm --filter agentic-kanban test` for cross-cutting changes) before mark-ready.
- `pnpm typecheck` (bounded workers, incremental; a new package with a `tsconfig.json` must be added to `PACKAGES` in `scripts/typecheck.mjs`). `pnpm test:e2e`. `pnpm db:migrate && pnpm db:seed`. `pnpm cli -- register <path>`/`list`/`cleanup`.

## Workspace Flow
`POST /api/workspaces` creates DB record + worktree + launches the agent. Then `/turn` (takes `content` not `message`; 409 if busy), `GET /diff`, `/merge`, `DELETE` (cascades). Loop: register repo → create issue → new workspace → diff → merge.

## Documentation Map
- `docs/agent-guide/` — the detail behind this file: `board-feedback`, `agent-providers`, `pre-merge-gate`, `architecture-notes`, `board-operations`
- `.llm/workflows.md` — clean-start, DB reset, registration, migration diagnosis
- `docs/prd/`, `docs/state.md` — vision, scope, data model, progress
- `docs/decisions/` — numbered decision records
- `docs/integration-risk-ladder.md` — risk ladder, release-candidate model
- `docs/two-boards.md` (dev vs stable, promotion), `docs/worker-fleet.md`, `docs/terminal-tracker.md`, `docs/backlog-markdown.md`
- `packages/server/CLAUDE.md` — server-package detail (incl. Butler ops); `scripts/board-monitor/README.md`
