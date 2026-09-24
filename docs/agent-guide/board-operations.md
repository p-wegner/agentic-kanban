# Board operations, orchestration, fleet, skills and plugins

_Moved verbatim from the root `CLAUDE.md` on 2026-09-25 (token pass). CLAUDE.md keeps the rules; this page keeps the rationale, incidents and detail. Section headings are the originals._

## Board Operations
Tool precedence: **MCP** (`mcp__agentic-kanban__*`) → **CLI** (`pnpm cli -- ...`) → **REST**. Use the board's own features — review (`POST /api/workspaces/:id/review`), merge (`merge_workspace`), fix-and-merge, rebase (`update-base`), enhance, dependency-analyze — don't replicate manually. For narrow questions use `list_issues`/`get_board_status`, not unbounded `list_workspaces`. Don't hand-roll `curl | python`.

**A program parsing `--json` output must not invoke the CLI via `pnpm cli -- ... --json` (#1109).** `pnpm run <script>` unconditionally prints a `> agentic-kanban@ cli ... > <command>` banner to stdout ahead of the script's real output — for ANY script name, and no flag inside the script body suppresses it. `json.load(stdout)` then fails on the banner text, not the JSON. Two ways out: pass `--silent` on the outer pnpm invocation yourself (`pnpm --silent cli -- issue get <N> --json`), or invoke `node scripts/cli-json.mjs -- issue get <N> --json` directly — it never goes through `pnpm run`, so the banner never fires. Prefer the latter from a script/agent, since it needs no flag to remember.

- Read a ticket: `pnpm cli -- issue get <N>` (`--json` for JSON).
- Backlog as ONE markdown file, both ways: `pnpm cli -- backlog export --out BACKLOG.md [--status …]` / `pnpm cli -- backlog import FILE [--apply]` (preview first); MCP `export_backlog_markdown` / `import_backlog_markdown`; UI Settings → UI → Export menu. Format + rules: `docs/backlog-markdown.md`.
- "resume #N" = `pnpm cli -- workspace resume <N>` (relaunch agent), not manual investigation.
- **A checkout moved on disk? RELOCATE it, never unregister + re-register** (#964) — the latter cascades away every issue, workspace and session the project had. `pnpm cli -- relocate <project> <new-path> --move` (one project) or `--prefix <old-dir> <new-dir> --move` (a whole parent directory, e.g. a consolidation); also `POST /api/projects/:id/relocate`, `POST /api/projects/relocate-prefix`, and the `relocate_project` MCP tool. Always `--dry-run` first — it prints the exact rows and directory renames. It rewrites every persisted path (`projects.repo_path`, `repos.path`/`worktree_path`, `workspaces.working_dir`, and `projects_base_path` when it named the old parent), moves the project's worktrees under the new parent and runs `git worktree repair`; issue text, comments and session records are deliberately left alone as a record of what was true then. When a column starts holding an absolute path, add it to `repositories/project-relocate.repository.ts` — that enumeration is what relocation can see.
- **Ticket groups (#661, decision 015)**: N coupled tickets in ONE workspace — one agent, one review, one merge-gate run; every ticket keeps its identity and closes when the branch lands. The grouping signal is the `coupled_with` edge: declare it at ticket creation (`create_issues_batch` `dependencies`) instead of writing "do together with #X" in prose, and consolidate an already-granular backlog with MCP `propose_ticket_groups` / `POST /api/issues/group-scan` (preview first, `apply: true` writes edges). The monitor then auto-starts the whole component as one group (cap 4; opt out per project with `auto_group_coupled_<id>=false`); manual starts pass `memberIssueIds` to `POST /api/workspaces`. Sizing rule for NEW tickets: a ticket is gate-sized — a few-minutes change is not its own ticket, it is a group member or part of its neighbour. (`workspaces.issueId` stays the group's LEAD; members live in `workspace_issue_members`.)
- `board-navigator` + `kanban-workflow` skills = full tool/command/workflow reference.
- **Butler** = warm per-project assistant (press `i`, MCP `ask_butler`, or `pnpm cli -- butler ask`).


## Agent Roles
Shared vocabulary; each maps to one mechanism — don't conflate.

| Name | Role | Mechanism | Trigger |
|---|---|---|---|
| **Conductor** | Out-of-process orchestrator driving an opted-in project (merge/unstick/start/refill) | `scripts/board-monitor/loop.sh` + a project objective; fresh session each ~30-min cycle | Dev board: `nohup bash scripts/board-monitor/loop.sh`; other projects: Start Mode `conductor` |
| **Autopilot** | In-process deterministic monitor (default for *other* projects; off here) | `runMonitorCycle`, `auto_monitor` pref | Settings → Workflow → Board Monitoring |
| **Steward** | In-process LLM monitor (off by default; reads `objective.md`) | `monitor-butler.ts`, `monitor_butler_enabled` | the `monitor_butler_enabled` pref |
| **Builder** | Per-ticket implementer in a worktree | `POST /api/workspaces` → agent in a worktree | New Workspace / Conductor |
| **Butler** | Warm conversational per-project assistant | Claude Agent SDK, in-process, one warm session/project | Butler view (`i`), `ask_butler`, `pnpm cli -- butler ask` |
| **Sentinel** | Human-side watch — polls Conductor health, reports one line, recovers only on failure | interactive Claude + `/loop` + cron | `/sentinel`, `sentinel` skill |
| **Smith** | Compounding-engineering session — analyzes past runs, forges durable improvements | `fleet-analysis`/`session-inspector`/`learning-step`/`distill-learnings` | those skills |

## Board-Monitor Orchestrator (this dev board)
The control plane for THIS board is the out-of-process loop `scripts/board-monitor/`: `loop.sh` spawns a fresh agent every ~30 min (`MONITOR_SLEEP`) reading `objective.md` (Claude unless `MONITOR_AGENT=codex`). Distinct from the in-process server monitor (off here, default elsewhere).

`objective.md` = single source of truth for monitor policy incl. its TUNABLE TARGETS block; re-read each iteration (no restart needed). The **Strategy Bullseye** UI (`board_strategy_<projectId>` pref) feeds all monitors via a generated `objective.md` block (agents) + `resolveMonitorTunables` pref read (deterministic); falls back to legacy `nudge_*` prefs. Per-cycle checklist = `board-monitor` skill; rationale = `docs/decisions/006-...md`.

> This board's `objective.md` DOES carry `STRATEGY_BULLSEYE_GENERATED_*` markers, so saving the Bullseye is safe: it rewrites only the block between them (TUNABLE TARGETS, STRATEGY WEIGHTS, PROVIDER POLICY) and auto-commits. The hand-authored `## FOCUS POLICY` block sits BELOW the END marker and is never touched — edit that one by hand. (An older caveat here claimed the file had no markers and that a Bullseye save would clobber it; that was stale, and verified so by an actual save in `839176433a`.)

### Driving a different project hands-off
**The single control for how a project's tickets get auto-started is its per-project Start Mode** (`start_mode_<projectId>` ∈ `manual | monitor | conductor`), resolved by `resolveStartPolicy()` (`start-policy.service.ts`) — the one decision EVERY auto-start path consults: in-process monitor **scheduling** (whether cycles run at all — `monitorShouldRun`/`monitorDrivenProjectIds` route through `resolveStartPolicy`, fixed ad729e70 per arch-review §3.4), per-cycle relaunch/merge/nudge, the post-merge dependency cascade, backlog refill, scheduled crons. Legacy `board_autodrive_<id>` is now DERIVED via `resolveStartPolicy` (back-compat), not read beside it — so `manual` is a true kill-switch and a `monitor` project schedules even with the global `auto_monitor` off. See decision 008. Set/observe it in the **Monitor view → Start Mode** control.
- **`manual`** — nothing auto-starts; only explicit `POST /api/workspaces` / relaunch. A true kill-switch (incl. the post-merge cascade, which previously leaked past every "drive" switch).
- **`monitor`** — the **in-process engine** (`runMonitorCycle` + auto-review/auto-merge + stranded-review reconciler) auto-starts unblocked backlog up to WIP. This is the supported hands-off driver for any project (NOT the Conductor / Monitor Butler — decision 006).
- **`conductor`** — the out-of-process loop is the sole driver; in-process stands down. The server supervisor launches `scripts/board-monitor/loop.sh` with that project's `repoPath`, `.kanban/objective.md`, and `.kanban/conductor/` state directory. Start/stop it from the Monitor view (Conductor mode) — `conductor-control.service.ts` / `POST /api/projects/:id/conductor`.
- **Back-compat / setDriveEnabled**: `board_autodrive_<projectId>="true"` (the legacy keystone) still works — Start Mode DERIVES `monitor` from it when `start_mode_<id>` is unset, and `setDriveEnabled` (the one-switch) writes `start_mode` (on=monitor/off=manual) so they never drift. Per-project Start Mode supersedes the global `auto_monitor`.
- Strategy Bullseye still feeds tunables via `resolveMonitorTunables` (no `objective.md` needed; `writeStrategyObjective` no-ops for non-Conductor repos). Without a Bullseye the defaults apply: WIP 5 (a stored legacy `nudge_wip_limit` still counts, but it is no longer writable), `backlogFloor=3`, `maxNewStartsPerCycle=3`.
- **A project's WIP is configured in ONE place — the Bullseye's `activeAgentsTarget` (#1102).** `wip_limit_<projectId>` was migrated into it at startup and retired (writes 422, like `nudge_wip_limit`), the per-column visual WIP limits are gone, and the toolbar **Autopilot chip** sets it (plus Start Mode, starts per cycle and the per-project auto-merge opt-out). Resolvers: `resolveWipLimit` (override → Bullseye → default), `resolveAutoMerge` (global `auto_merge` AND NOT `auto_merge_disabled_<id>`), and `decideStartSlots` for how many tickets the next cycle may start — which `GET /api/projects/:id/autopilot` reuses, so the chip shows the monitor's own arithmetic.
- Tag an issue `no-auto-start` to keep the monitor from launching it.

## Worker Fleet (remote compute)
Agents can execute on OTHER machines. Workers dial the board (`agentic-kanban worker start --board <url> --token <pairing-token>`), hold a WebSocket for assignments, and stream output back — the board's broadcast/persistence/exit-classification are untouched, because only PLACEMENT moved (`Placement = host | container | remote`, dispatched in `agent-dispatch.service.ts`). Decision 012.
- **Opt in per project**: `worker_dispatch_<projectId>=true`; require capabilities with `worker_labels_<projectId>=docker,linux`; `worker_dispatch_strict_<projectId>=true` forbids the host fallback (the monitor then skips with `no_available_worker` instead of running locally).
- **Git transport**: the board serves its repos over token-authed git smart HTTP; a worker clones, works in its OWN checkout, and pushes to `refs/kanban/incoming/<branch>` (pushes to `refs/heads/*` are refused — those are checked out in board worktrees). The board fast-forwards the real branch from there, so diff/review/merge are unchanged. **Fast-forward only** — divergence is held and reported, never forced.
- A worker on the SAME machine can skip git transport with `worker start --shares-filesystem`.
- **Credentials never leave their machine**: a worker authenticates its agent with its own local login; the board sends none. Enforced (#244), not just intended — the remote launch spec's env comes from the allowlist in `packages/server/src/lib/remote-spec-env.ts` and the worker MERGES it over its own environment. Adding a var an agent needs remotely means adding it to that allowlist; anything credential-shaped is rejected there by design.
- **A worker ATTESTS its profiles** (#1027): `worker start --profiles anth,team5x` (names only; omit the flag to attest what local discovery finds, `--profiles none` to attest nothing) declares which agent logins that machine can authenticate as, on `hello` and on every heartbeat alongside `--providers`/`--labels` — with each profile's self-declared role and a quota reading the worker takes against its own tokens. That is what lets a profile-restricted project dispatch remotely at all (see the #651 paragraph in Agent Providers); the launch spec then carries the chosen profile's NAME, and a worker that no longer holds it rejects the assign instead of running under another account.
- **Git tokens are per assignment** (#247): scoped to one worker + one project + one incoming ref, expiring, and invalidated by `revokeWorker` (which also closes the worker's live socket). The startup incoming-ref sweep lands a ref only when the DB holds a matching dispatch (#246) — an unmatched ref is held and reported, never fast-forwarded.
- **The board ASKS instead of waiting** (#887): a worker remembers every `sessionId` it was ever handed, so `probe_session` → `unknown` is an AUTHORITATIVE "the assignment never arrived", not a timeout's guess (measured: a lost assign held a session 100 minutes). Sent once, after `ASSIGN_SILENCE_PROBE_MS` of zero output. **Silence is NOT `unknown`** — a worker older than the message cannot answer, so an unanswered probe holds exactly as before and #883's silence TTL stays the backstop. `unknown` counts only from the worker the session was assigned TO. Board half: `services/agent-remote-liveness.ts` (which also owns the free half — the `hello` reverse-reconcile); worker half: `worker/worker-session-registry.ts`.
- **Strict dispatch is enforced at LAUNCH time too** (#245): `strict` rides on the `Placement`, so a worker vanishing between placement and `assign` fails the session with `NO_AVAILABLE_WORKER` instead of quietly running on the board host.
- **Never `KANBAN_HOST=0.0.0.0` for a fleet** — the board API has no auth. Expose `KANBAN_FLEET_PORT` (worker register/heartbeat/ws only) and `KANBAN_GIT_HTTP_PORT` (git transport only) instead; both are opt-in, bearer-token authed, and the board API is never mounted on them. Remote workers point `--board` at the FLEET port. `KANBAN_FLEET_HOST` / `KANBAN_GIT_HTTP_HOST` narrow WHICH interface each one binds (absent = every interface, as before) — on a VPN that is what turns "keep it on a trusted network" into an actual control. Don't put a path-based reverse proxy (`tailscale serve`, an nginx prefix) in front of the git transport: the worker rebuilds the URL as `scheme://<host>:<git-port>/git/<projectId>` and drops the prefix, so the clone hangs with no visible cause.
- UI: command palette → "Worker Fleet" (pair/revoke, status, capacity, labels).

## Server Resilience
Agent subprocess callbacks wrapped in try/catch in `agent.service.ts`; `uncaughtException`/`unhandledRejection` log `[fatal]`; stale sessions cleaned on startup in `index.ts` after migrations. `auto_monitor` force-disabled on every boot.

## Agent Skills
Prompt templates in the `agent_skills` table, written to `.claude/skills/<name>/SKILL.md` in the worktree on creation. API: `GET/POST/PUT/DELETE /api/agent-skills` (`?projectId=` = global + project); MCP: `list/get/create/export_agent_skills`.
- **Built-in** (`packages/server/src/builtin-skills.ts`, `isBuiltin: true`, `pnpm db:seed`): `board-navigator`, `code-review`, `code-review-thorough`, `dependency-analyzer`, `ticket-enhancer`, `orchestrator`, `monitor-nudge`, `kanban-workflow`, `backlog-markdown` (agentic import/export of a backlog as one `.md`, see `docs/backlog-markdown.md`), `fleet-worker`. Generic, shipped in npm.
- **Project-specific** live only in `.claude/skills/` (e.g. `publish`, `cleanup`, `board-monitor`, `dev-server`, `db-doctor`) — **do NOT add to `builtin-skills.ts`**. `session-inspector` is **not a copy here any more** (2026-08-26): it is a gitignored junction to `C:\projectsndrena\claude-session-tools\session-inspector` (github.com/p-wegner/session-inspector-skill), the single source of truth — recreate the junction on a fresh clone. Board-local session scripts with no counterpart there (`scripts/session-rank.mjs`, `scripts/output-style.mjs`, `scripts/analyze-failure-recovery.mjs`) stay in `scripts/`.
- The review prompt uses built-in `code-review`; override per-project with a project-scoped `code-review` skill. Placeholders: `{{branch}}`, `{{baseBranch}}`, `{{issueId}}`, `{{autoFixInstructions}}`.
- A **plugin** skill is junctioned into `.claude/skills/<name>` on enable, so it is a *disk* skill with a whole bundle (`tools/`, `references/`), not a DB row. Both the scanners and `copySkillToWorktree` handle that now — junctions are followed (`readdir` reports them as symlinks, never directories) and the FULL directory is copied into the worktree, since a skill whose `tools/` is missing documents commands that don't exist.

### Bundled skills — a DIRECTORY that ships in the package, generated from source
`packages/server/skills/<name>/` (in `files`, so it ships on npm). Today: **`agentic-kanban`** — the
board's own feature map for any agent on any machine: a hand-written overview plus `references/`
(concepts, workflows, and a generated MCP-tool / CLI / views-and-shortcuts reference).

Why a directory and not another `builtin-skills.ts` string: a prompt string cannot carry a
`references/` bundle, and it cannot be **linked**. A bundled skill is junctioned into its install
target, so one install keeps tracking the package across upgrades instead of rotting into a copy of
last release's feature list.

- **Generated from source, not maintained by hand.** `node packages/server/scripts/generate-bundled-skill.mjs`
  (`pnpm skill:generate`) extracts the MCP tool table, every CLI command group, the view registry and
  the shortcut registry, and rewrites only the `<!-- GENERATED:… -->` blocks plus the `commit:` stamp
  — the prose between them is hand-written and never touched. `--check` (`pnpm skill:check`) exits 1
  when the committed output differs from what source would produce now.
- **The gate is content-based, not SHA-based** — `bundled-skill-freshness.test.ts` (`@gate:always-run`,
  it spawns the generator over the whole tree) fails only when an enumerable thing actually changed.
  So adding an MCP tool or a CLI command turns it red until you re-run the generator; editing an
  unrelated file does not.
- **Install:** `agentic-kanban install-skill [path]` (project) or `install-skill --user` (every
  `~/.claude*/skills` and `~/.codex/skills` on the machine), MCP `install_skill`. Junction by default,
  `--no-link` to copy. A junction that cannot be created (npx cache, no symlink permission) degrades
  to a copy and SAYS SO rather than failing.
- **`--user` is bundled-only** unless a prompt-only built-in is named with `-n`. The prompt-only
  built-ins are per-project working prompts the board materializes into worktrees itself; installing
  them machine-wide would offer every agent in every repo a review prompt written for one board. Both
  rules (this one, and bundled-beats-same-named-prompt) live in `selectSkillsToInstall` — call it
  rather than re-deriving either at a new install site.
- **Check:** `agentic-kanban skill verify [path] [--user]` — `linked` (cannot go stale), `current`,
  `stale`, or `absent`; exit 1 on stale, so it works from a hook or CI.
- A bundled directory **wins over a same-named DB built-in** in both the CLI and the MCP tool: it is
  the richer form of the same skill, and installing both would leave the loser's `SKILL.md` behind.

## Plugins
**Writing or reviewing one? Read [docs/plugin-development.md](docs/plugin-development.md) first** — the self-contained guide (lifecycle, every field, the four loop rules that fail silently, a copy-pasteable minimal plugin, a test recipe, a checklist, and the known gaps). It is written for an agent with no prior knowledge of this board, so it is also the thing to hand to one.

**Improvement net** = the board plus the plugin family for tool-assisted, ambitious refactoring of large legacy projects (understand & protect → measure → find potential → change safely → track & learn; findings become tickets, and what the tools lack flows back to the toolset as backlog). Pattern + hand-offs: `docs/plugin-development.md` § "Plugins that form an improvement net". The concrete plugins are not part of this repo; an installed plugin's `docs[]` page (Plugins menu) is where their map lives.

A plugin is a repo with a `kanban-plugin.json` manifest (`packages/shared/src/lib/plugin-manifest.ts` is the contract). It declares `skills`, iframe `views` (supervised child servers), one-shot `scripts`, `loops`, a butler `promptFragment`, and a `scaffold` template. Install once (Settings → Plugins), enable per project (`plugin_enabled_<slug>_<projectId>`); the **Plugins board view** is where all four kinds are started. Reference implementations: **refactor-safety-net** (many skills + views) and **reqextract** (four loops, bootstrap unit, state outside the plugin checkout, offline self-test).

**`loops` = board-owned converging analysis.** The plugin contributes only a deterministic `plan` command printing the outstanding work units as JSON; the BOARD does everything that spawns an agent — a ticket per unit carrying the loop's skill, started by the monitor within the project's WIP limit, under the Strategy Bullseye's provider selection and the auth-rotation ring (a quota-exhausted profile rotates mid-loop). Loop state IS the tickets, so it survives a restart with no private run-log.
- **Unit ids are the planner's contract.** Each ticket stores `pluginLoopUnitKey(slug, loop, unitId)` in `external_key`, and an advance skips any unit already ticketed — terminal or not. A planner wanting another pass must mint a FRESH id (`billing:r3`), which is what makes an infinite ticket loop impossible.
- A round is only replanned once its tickets are all terminal, and only for a loop that already has tickets — so `advanceDuePluginLoops` (monitor pass) *continues* loops a human started and never starts one itself.
- **`converged` is a claim about the JOB, not the current ready set.** A loop with nothing to do *right now* because its upstream is unfinished must report `units: [], converged: false` (the board's "blocked, not done"); reporting `true` ends a loop that then needs a human to restart it.
- **`{{repoPath}}` is the OUTPUT repo** (leading repo, or the `<slug>-requirements` sidecar), not the product repo; **`{{leadingRepoPath}}` is always the product repo** regardless of output location (#213), so a plugin that READS the source and WRITES elsewhere expresses that with the two placeholders and works in sidecar mode. What still has no placeholder is a SIBLING repo — one that is neither leading nor the plugin's own output.


## Clean-clone / first-start blockers (Windows)
Full symptom→cause→fix in `docs/install.md` (“Clean-clone / first-start gotchas”). The `dev-server` skill Step 0 handles bootstrap automatically (no DB → `pnpm db:setup`; 0 projects → register). Key facts for triage:
- **`spawn pnpm ENOENT`** — fixed: launcher/preflight scripts re-invoke pnpm via `npm_execpath` (`scripts/pnpm-exec.mjs`), so any pnpm install method works. If it still fires, pnpm is missing from PATH entirely.
- **Client shared resolution** — fixed; `vite.config.ts` uses `development` condition → `src/`. Fallback: `pnpm --filter @agentic-kanban/shared build`.
- **Backend hangs (proxy up, nothing on 13001)** — `tsx watch` + Node 23.x on Windows; use Node LTS 22 (the declared floor since #731; Node 20 is EOL).
- **DB location** — `packages/server/kanban.db`; absent → falls back to `~/.agentic-kanban/kanban.db` (board looks empty).

## Common Commands
- `pnpm dev` — server + client. **In THIS main checkout it is the wrong door since #1013**: it takes 3001/5173 and the operated database — the stable board's ports and DB, which are already in use by the board that operates every project. Use `pnpm dev:devboard` here. Plain `pnpm dev` is for **worktrees**, which get their own ports (`feature/<N>-…` = `3001+N`/`5173+N`). `pnpm dev:desktop` adds Tauri. Safe headless launch: `dev-server` skill.
- **`pnpm dev:devboard` — the DEV board** (`KANBAN_BOARD_ROLE=dev`): 3101/5273 and its OWN database (`~/.agentic-kanban-dev/kanban.db`), so board development stops restarting the server that operates every project. One switch decides both ports and DB — they are not settable apart — and the launcher REFUSES to open `~/.agentic-kanban/kanban.db` or `packages/server/kanban.db` under this role. The stable board (built artifact, a sibling checkout pinned to a dated `stable-YYYYMMDD[-N]` tag) keeps 3001/5173 and registers `agentic-kanban`; the dev board never does. Runbook incl. the operator cutover checklist: **`docs/two-boards.md`**.
- **`pnpm promote` — how a landed change reaches the board that operates everything.** Master goes
  to the stable checkout by a **timed promotion, never per merge**: the run reads the last
  full-sweep verdict for `master` out of the `base_branch_health` table (it never re-runs the
  suite), REFUSES on anything that is not a fresh green for that branch — and on a sha the stable
  checkout is already ahead of — then tags `stable-YYYYMMDD[-N]`, fast-forwards + rebuilds +
  migrates + restarts `../agentic-kanban-stable`, and smoke-tests it. A failed smoke rolls back to
  the previous tag and RETIRES the failed tag name. **`pnpm promote --dry-run` first, always**;
  `--force-sweep` promotes without a green verdict, loudly. Exercised for real over five runs on
  2026-09-05 (#1014). Full semantics, the rollback rehearsal seam, and the
  `<stable>/.kanban/promote.log` the Sentinel reads: **`docs/two-boards.md` §8**.
  - **It ASKS for the sweep it needs rather than sending you to `--force-sweep` (#1044).** A forced
    promotion tags the branch TIP, leaving stable AHEAD of the last recorded sweep — after which the
    honest path refused as `behind` and only another `--force-sweep` got through, so each forced run
    made the next honest one impossible. When the only thing missing is a CURRENT verdict the run now
    POSTs `…/base-branch-health/reprobe` and waits (`KANBAN_PROMOTE_SWEEP_WAIT_MIN`, default 40 min),
    then judges the fresh row by the same rules. It never re-probes a RED master and never treats the
    wait as permission: a probe that does not land refuses exactly as before. `--no-await-sweep`
    restores the old behaviour. It also PRINTS the accumulated pre-merge-gate evidence from the
    test-impact ledger since the last sweep (#1045) — explicitly labelled as the weaker, different
    measurement it is, and authorizing nothing.
