---
module: monitor-orchestration
name: Monitor / Conductor / Autopilot (board orchestration)
capability: Drive kanban tickets to "done" with no human in the loop — decide per project HOW work auto-starts, relaunch/merge/nudge in-flight work up to a WIP target, and keep the backlog fed.
files: 14
source_paths:
  - packages/server/src/startup/monitor-*.ts
  - packages/server/src/services/start-policy.service.ts
  - packages/server/src/services/strategy-objective.service.ts
  - packages/server/src/services/conductor-control.service.ts
  - packages/server/src/services/monitor-butler.ts
  - packages/server/src/services/drive*.service.ts
  - packages/server/src/routes/drive.ts
  - packages/server/src/routes/board-monitor.ts
entry_points:
  - packages/server/src/startup/monitor-setup.ts:178 — scheduled (the in-process cycle + event trigger)
  - packages/server/src/routes/drive.ts:19 — API (one-switch Drive + preflight)
  - packages/server/src/routes/board-monitor.ts:57 — API (Conductor start/stop, tunables, schedule)
  - packages/server/src/services/monitor-butler.ts:277 — scheduled (LLM monitor scheduler)
analyzed_sha: 2cea8d3e
depends_on: [workspaces, review-merge, preferences-config, issues-board]
structure: scattered
---

# Monitor / Conductor / Autopilot (board orchestration)

## Purpose & business capability

This module is the board's **control plane**: the machinery that moves tickets toward delivery
*without a person clicking buttons*. The product promise of agentic-kanban is "register a repo,
seed an epic, walk away, come back to merged code." That promise is kept here.

Three distinct roles answer the same question — "what work should run next, and what should I do
about work that's already running?" — but with different mechanisms and different trust levels:

- **Autopilot / in-process Monitor** — a deterministic, code-only loop inside the server
  (`runMonitorCycle`, `monitor-setup.ts:178`). It needs no LLM. It relaunches dead agents, merges
  approved work (behind gates), nudges stuck agents, auto-starts unblocked backlog up to a WIP
  target, and refills an empty backlog. This is the **supported hands-off driver for any project**.
- **Conductor** — an *out-of-process* loop (`scripts/board-monitor/loop.sh`) that spawns a fresh
  agent every ~30 min reading `objective.md`. `conductor-control.service.ts` only *starts/stops* it;
  the loop itself lives in shell. Used for the dogfood board only (the repo that ships the script).
- **Monitor Butler** — an *in-process LLM* monitor (`monitor-butler.ts`): a fresh Claude Agent SDK
  session on a schedule that reads the same `objective.md`, acts through MCP tools, and logs to an
  audit table. Off by default; an alternative to the deterministic Autopilot when you want judgment.

If this module vanished, the board would still let a human start/merge/relaunch workspaces by hand,
but every "drive a 20-ticket epic to done overnight" workflow, every backlog refill, every
auto-merge of approved work, and every stuck-agent recovery would stop. The board would become a
manual task tracker with an agent-launch button.

**The hard-won lesson encoded everywhere here:** these mechanisms must *never double-drive a board*
(two starts of the same ticket → conflicting worktrees). Hence the single Start Mode gate, the
re-entrancy guard, and the "conductor stands down the in-process monitor" rule.

## Ubiquitous language

| Term | Meaning *as used here* | Defined at |
|------|------------------------|------------|
| **Start Mode** | The one per-project decision for HOW tickets auto-start: `manual` \| `monitor` \| `conductor`. The single source of truth every auto-start path consults. | `start-policy.service.ts:24,57` |
| **Autopilot** (in-process Monitor) | The deterministic, LLM-free server-side cycle. Term "Autopilot" is the CLAUDE.md/user word; the code calls it "the monitor" / `runMonitorCycle`. | `monitor-setup.ts:178` |
| **Conductor** | The out-of-process `loop.sh` driver; sole driver when Start Mode = conductor. | `conductor-control.service.ts:1-10` |
| **Monitor Butler** | In-process LLM board-health agent (fresh SDK session per cycle). Distinct from the warm *User Butler*. | `monitor-butler.ts:1-30` |
| **WIP target / ACTIVE_AGENTS_TARGET** | How many workspaces should be *actively running an agent* at once (`active`/`reviewing`/`fixing`). The auto-start ceiling. | `strategy-objective.service.ts:87,205`; `monitor-auto-start.ts:24` |
| **Backlog floor** | Minimum count of unstarted Todo issues; below it, refill is triggered. | `strategy-objective.service.ts:206`; `monitor-backlog.ts:176` |
| **maxNewStartsPerCycle** | Cap on NEW workspaces a single cycle may launch (staggering, anti-stampede). | `strategy-objective.service.ts:207`; `monitor-auto-start.ts:150` |
| **Strategy Bullseye** | Per-project JSON pref (`board_strategy_<id>`) that derives the tunables + provider routing. The intended control surface; legacy `nudge_*` prefs are the fallback. | `strategy-objective.service.ts:398` |
| **Drive (one-switch)** | The "make this project build hands-off" toggle that sets a *coherent* set of prefs at once (autodrive on, kill-switch off, review+merge on, planMode off, verify gate ensured). | `drive.service.ts:113` |
| **Drive (record)** | A first-class DB row tracking a hands-off epic run (`target`, `completionContract`, status, `metaIssueId`, retro). Different noun from the toggle above. | `drive.service.ts:175-256` |
| **Drive obstacle** | Structured telemetry event for drive friction (over-launch, gate failure, stall, etc.). | `drive-obstacles.service.ts:22-35` |
| **Candidate** | An in-flight workspace the cycle evaluates (joined issue+workspace+status row). | `monitor-cycle.ts:39` |
| **WorkspaceActions port** | Injected interface for relaunch/merge/fix-and-merge/delete — replaces self-HTTP so the cycle calls the app service directly. | `monitor-cycle.ts:56-65` |
| **Auto-contract** | Pre-fan-out step that merges `coupled_with` tickets into one so they never start as conflicting parallel workspaces. | `monitor-contract.ts:8-26` |

## Domain model & invariants

| Invariant / rule / policy | Why (business reason, inferred) | Enforced at |
|---------------------------|----------------------------------|-------------|
| **Start Mode is the single kill-switch; finer prefs only enable.** `manual` truly stops *all* auto-start (incl. post-merge cascade, refill, scheduled); `monitor` enables in-process starts; `conductor` keeps in-process OFF. | Before this, turning "drive" off didn't stop the post-merge cascade (its own gate) — a project kept auto-starting with every switch off. The mode ANDs over the legacy flags. | `start-policy.service.ts:57-97` |
| **Per-project Start Mode supersedes the global `auto_monitor` toggle.** The global flag only participates in *deriving* a mode when `start_mode_<id>` is unset. | A freshly-registered project must be drivable without flipping a global switch; back-compat for projects that predate Start Mode. | `start-policy.service.ts:57-62,103-108` |
| **`conductor` is never *derived*, only set explicitly.** | The external loop is the dogfood-board control plane; auto-electing it for arbitrary projects would launch a shell loop they can't run. | `start-policy.service.ts:103-108` |
| **A cycle never overlaps itself (re-entrancy guard).** If a trigger arrives mid-cycle, run exactly one more pass at the end. | Two concurrent cycles could each see the same unblocked issue (no workspace yet) and both POST a workspace → double-start → conflicting worktrees. | `monitor-setup.ts:130,178-184,287` |
| **WIP counts only `active`/`reviewing`/`fixing` workspaces.** A `blocked` usage-limit launch or an `idle` zero-output launch failure must NOT hold a slot. | Old `status != 'closed'` over-counted launch failures, so the board looked full while nothing ran (#690), starving real work. | `monitor-auto-start.ts:24,40-69` |
| **Auto-merge requires `auto_merge` pref = "true" AND merge strategy = "monitor"; per-project `auto_merge_disabled_<id>` overrides.** | Operator kill-switch for automatic landing, with a per-project escape hatch; manual `POST /merge` is never affected. | `monitor-cycle.ts:73,209-217`; `monitor-setup.ts:246` |
| **Un-ready In-Review/stopped-review work is merged only after the pre-merge gate passes.** A failed verify/smoke WITHHOLDS the merge (leaves In Review). | `auto_merge_in_review` once bypassed the verify+smoke gate that lived only in the review-exit handler → unverified code landed (#821). Gate now runs at the merge site too. | `monitor-cycle.ts:238-268,322-336`; `projectHasMergeGate` 126-135 |
| **Feature/enhancement tickets are excluded from global auto-start UNLESS the project is auto-driven.** | Feature tickets are human epic-planning artifacts globally, but ARE the intended work on a driven project; excluding them makes the epic invisible (#773). | `monitor-eligibility.ts:27-53` |
| **Drive/epic META issues are never auto-started as builders.** Detected via a Drive record's `metaIssueId` OR a parent_of/child_of edge; enforced both per-issue and in the candidate SQL. | You don't *build* the meta — its children are the leaves; a stray builder on the meta drifts to In Review and inflates WIP, starving real leaves (#824/#664). | `monitor-auto-start.ts:87-109,164,236` |
| **A blocker unblocks dependents only when it reached a terminal status AND its work actually landed on the base branch** (`mergedAt`/`isDirect`), not merely "Done". | "Done" without a merge means the dependent builds against missing code; one shared `computeBlockerReadiness` fixes the whole #535/#537/#782/#784 class. | `monitor-auto-start.ts:252-288` |
| **`no-auto-start` tag is an explicit per-issue opt-out.** | Lets a human/skill fence off a ticket (e.g. REST-seeded epic metas) from the monitor. | `monitor-auto-start.ts:11,71-77,172,250` |
| **Relaunch cap = 2/cycle, merge cap = 2/cycle, maxNewStarts cap (default 2, Bullseye-tunable).** | Stagger actions so earlier work lands before the next batch; a per-project autodrive project with many Todos would otherwise launch them ALL into conflicting worktrees (#532). | `monitor-cycle.ts:36-37`; `strategy-objective.service.ts:207,418` |
| **Stuck-builder recovery only fires for builder sessions that are 0 commits ahead AND (have a non-trivial uncommitted diff OR a repeated-failed-command retry loop).** | Distinguish "agent is stuck in a loop / sitting on uncommitted work" from "agent legitimately working"; commit the leftover work and route to review instead of killing progress. | `monitor-cycle.ts:137-190`; `monitor-cycle-rules.ts:26-45` |
| **A workspace with ≥10 sessions (or ≥5 while In Review) is force-closed as "stuck".** | Break infinite relaunch/review loops that never converge. | `monitor-cycle.ts:224-237`; `MAX_SESSIONS` rules:4 |
| **Maintenance window suppresses all disruptive actions.** | An operator can freeze automation during a manual intervention without disabling the monitor entirely. | `monitor-setup.ts:171-176,204-209` |
| **Backlog refill is gated, rate-limited (cooldown, default 120 min), and the host issue is born In Progress** (never Todo) so it can't re-trigger itself. | Prevent refill spam and self-feedback loops; only generate work when the board is genuinely starved and not already busy. | `monitor-backlog.ts:52-53,138-200` |
| **Conductor start is a no-op if one is already alive.** | The caller must never get two external drivers on one board. | `conductor-control.service.ts:52` |
| **Drive ON sets a *coherent* pref set atomically; provider/profile is intentionally NOT owned by Drive.** | Individually-set drive prefs drift (autodrive on but kill-switch armed, no verify gate); provider is the Strategy Bullseye's job and must survive a triage⇄drive flip. | `drive.service.ts:29-56,113-146` |
| **Drive preflight auto-repairs ONLY when *every* blocker is one-switch-fixable.** No statuses / null defaultBranch / dirty main / exhausted provider are reported, never silently worked around. | Flipping Drive on can't conjure a default branch or a healthy provider; claiming a repair that leaves real blockers is worse than reporting honestly (#807). | `drive-preflight.service.ts:319-342` |

## Key workflows / use cases

### 1. The in-process Monitor cycle (Autopilot)

Trigger: a poll timer (`auto_monitor_interval`, default 4 min) OR a debounced board event
(merge/session-exit/ticket-created, ~1.5 s). Orchestrated by `runMonitorCycle`
(`monitor-setup.ts:178`).

```mermaid
stateDiagram-v2
  [*] --> Guard
  Guard --> Skip: cycleRunning (note rerun) / !shouldRun / maintenance window
  Guard --> Scope: ok
  Scope --> Sweep: allowProject + shouldAutoStartProject + allowBacklogRefill resolved
  Sweep --> ProcessInflight: stale dev-process + warning sweep
  ProcessInflight --> AutoContract: relaunch / merge / nudge / recover each candidate (capped)
  AutoContract --> AutoStart: contract coupled components (opt-in)
  AutoStart --> Refill: start unblocked backlog up to WIP, ≤ maxNewStarts
  Refill --> Reschedule: generate tickets if backlog < floor (opt-in, cooldown)
  Reschedule --> [*]: re-arm timer; run one more pass if a trigger arrived mid-cycle
```

Per-candidate decision tree (`processWorkspaceCandidates`, `monitor-cycle.ts:414`):
- **idle** → Codex-limit → mark blocked; zero-diff-In-Review → leave (needs attention); direct →
  close as Done; readyForMerge → auto-merge (gated) with fix-and-merge fallback; ≥MAX_SESSIONS →
  close stuck; In Review → auto_merge_in_review (gated, runs pre-merge gate) else leave; else
  **relaunch** (capped).
- **reviewing** → ghost (no workingDir) → delete + reset to In Progress; review session stopped →
  run pre-merge gate if not ready → merge (NO fix-and-merge fallback on this path).
- **active+stopped** → mark idle for relaunch (or close if direct).
- **active+running** → process dead → mark idle; past stuck timeout → recover stuck builder; past
  5 min → nudge (skip re-nudge if agent visibly working).

Failure handling: every candidate is wrapped in try/catch (`monitor-cycle.ts:454`); a single bad
workspace never aborts the cycle. Best-effort DB updates use `.catch(() => {})`.

### 2. Auto-start (fan-out) — `runAutoStart` (`monitor-auto-start.ts:132`)

Trigger: end of cycle, per project where `resolveStartPolicy(...).autoStartUnblocked`. Two loops:
(a) **backfill** In-Progress issues that have no open workspace; (b) **pull** Todo (and Backlog for
auto-driven projects) issues whose dependencies have all *landed*. Both respect WIP target and
`maxNewStartsPerCycle`. Drive/epic metas and `no-auto-start` issues are filtered out. Launches via
`POST /api/workspaces` (still self-HTTP here, unlike the inflight actions port).

### 3. Backlog refill — `runBacklogEmptyStrategy` (`monitor-backlog.ts:121`)

Trigger: per project where `backlogRefill` is allowed AND `backlog_empty_strategy ==
"generate_tickets"`. When unstarted-Todo count < backlog floor AND WIP < target AND cooldown
elapsed, create a synthetic host issue (In Progress) and launch a generation skill
(`architecture-improvement` default) with a scoped, local-only prompt; `REFILL_FOCUS` steers
bugfix-only vs balanced. Cooldown stamped only on success.

### 4. Conductor lifecycle — `conductor-control.service.ts`

`POST /api/projects/:id/conductor {action:start|stop}` (`board-monitor.ts:57`). Start spawns
`bash scripts/board-monitor/loop.sh` detached (survives hot-reload), records the OS PID, clears the
stop-marker. Stop tree-kills by recorded PID + a robust PowerShell backstop that reaps every
`loop.sh`, then drops a stop-marker so the read-only status reports "stopped" immediately. A
cron schedule (`#841`) fires single off-process cycles (`MONITOR_MAX_ITERS=1`, `MONITOR_SLEEP=0`).

### 5. Monitor Butler cycle — `runMonitorButlerCycle` (`monitor-butler.ts:112`)

Trigger: scheduler (`monitor_butler_enabled`, `monitor_butler_interval_min` default 15). Snapshot
board → resolve strategy from `objective.md` (else built-in default) → spawn a fresh Agent SDK
session (10-min hard timeout) → it acts through MCP tools → log every tool call + start/end to
`board_health_events`. Stateless by design; a crashed cycle never poisons the next.

### 6. Drive enablement + preflight — `drive.service.ts` / `drive-preflight.service.ts`

`PUT /api/projects/:id/drive {enabled}` flips the coherent pref set (and ensures stack profile +
verify gate when ON). `GET|POST /api/projects/:id/drive/preflight` runs the machine-checkable
prerequisite checklist; with `autoRepair` it flips Drive on iff *every* blocker is one-switch-fixable
and re-evaluates.

## Entry points

| Entry point | Kind | What it lets a caller do | `file:line` |
|-------------|------|--------------------------|-------------|
| `runMonitorCycle` | scheduled / event | One full Autopilot pass (process inflight, contract, auto-start, refill) | `monitor-setup.ts:178` |
| `POST /api/internal/monitor-run` | API (internal) | Force a cycle now | `monitor-setup.ts:79` |
| `POST /api/internal/resource-sweep` | API (internal) | Reap orphaned worktree dev servers on demand | `monitor-setup.ts:89` |
| `GET /api/internal/monitor-status` | API (internal) | Read monitor state, recent actions, warnings, maintenance | `monitor-setup.ts:100` |
| `GET/PUT /api/projects/:id/drive` | API | Read / flip the one-switch Drive | `routes/drive.ts:22,37` |
| `GET/POST /api/projects/:id/drive/preflight` | API | Assert / auto-repair hands-off prerequisites | `routes/drive.ts:26,30` |
| `POST /api/projects/:id/conductor` | API | Start/stop the out-of-process Conductor loop | `routes/board-monitor.ts:57` |
| `GET /api/projects/:id/orchestrator` | API | Read-only Conductor liveness/phase | `routes/board-monitor.ts:33` |
| `GET /api/projects/:id/monitor-tunables` | API | Effective tunables + source + start policy (UI provenance) | `routes/board-monitor.ts:42` |
| `GET/PUT /api/projects/:id/conductor-schedule` | API | Per-project Conductor cron | `routes/board-monitor.ts:79,87` |
| `startMonitorButler` | scheduled | (Re)start the LLM-monitor scheduler | `monitor-butler.ts:277` |

## Logic-bearing code (where the real decisions live)

| File / function | What decision/logic it holds | `file:line` |
|-----------------|------------------------------|-------------|
| `resolveStartPolicy` | The one decision every auto-start path consults: mode → which capabilities are on. Read this first. | `start-policy.service.ts:57` |
| `runMonitorCycle` | The cycle orchestrator: guards, scoping predicates, ordering (process → contract → start → refill), re-arm + rerun. | `monitor-setup.ts:178` |
| `processWorkspaceCandidates` + per-status handlers | Per-workspace relaunch/merge/nudge/recover policy incl. all gating; the densest rule cluster. | `monitor-cycle.ts:192-459` |
| `runAutoStart` | WIP/maxNewStarts caps, dependency-readiness, meta/feature/skip filtering, In-Progress backfill + Todo/Backlog pull. | `monitor-auto-start.ts:132` |
| `countWipCapacity` | Defines what "busy" means (the #690 active-only WIP semantics). | `monitor-auto-start.ts:54` |
| `resolveMonitorTunables` / `deriveMonitorTunables` | Strategy-Bullseye-vs-legacy tunables; the numeric policy (WIP/floor/maxStarts/refillFocus) + clamps. | `strategy-objective.service.ts:192,398` |
| `isMonitorEligibleIssue` / `monitorEligibleIssueSql` | Feature-exclusion policy (and its auto-driven no-op). | `monitor-eligibility.ts:27,40` |
| `isDriveOrEpicMeta` / `notDriveOrEpicMetaSql` | Meta-never-built rule, two enforcement points. | `monitor-auto-start.ts:87,106` |
| `recoverStuckBuilder` + `monitor-cycle-rules.ts` | Stuck detection thresholds (timeout, diff size, retry-loop, MAX_SESSIONS). | `monitor-cycle.ts:137`; `monitor-cycle-rules.ts` |
| `setDriveEnabled` / `runDrivePreflight` | The coherent-pref-set contract + the prerequisite gate w/ auto-repair-only-if-all-fixable rule. | `drive.service.ts:113`; `drive-preflight.service.ts:169` |
| `selectProviderFromStrategy` / `isPolicyBlockedByQuota` | Provider routing priority (fill→throttle→fallback) with live-quota gating. | `strategy-objective.service.ts:449,490` |

## Dependencies & bounded-context relationships

- **workspaces** (Customer-Supplier; this module is the customer): the cycle drives relaunch/merge/
  fix-and-merge/delete via the injected `MonitorWorkspaceActions` port (`monitor-cycle.ts:56-65`) —
  *not* self-HTTP — and auto-start/refill still `POST /api/workspaces` (self-HTTP, an inconsistency).
- **review-merge** (Shared Kernel): `runPreMergeGate` (`pre-merge-gate.service.ts`) and
  `startManualReview` enforce the verify+smoke quality gate the monitor must honor before landing
  un-ready work; `projectHasMergeGate` decides whether `auto_merge_in_review` is safe.
- **preferences-config** (Conformist / Published Language): everything is driven by the preferences
  table — `start_mode_<id>`, `board_strategy_<id>`, `auto_monitor`, `auto_merge*`, `board_autodrive_<id>`,
  `nudge_*`, `monitor_butler_*`, `auto_contract_coupled_<id>`. Tunables resolution is the published
  contract between the UI Bullseye and all three monitor mechanisms.
- **issues-board** (Shared Kernel): reads issues/statuses/dependencies/tags/workflowNodes to pick
  candidates; writes status transitions (`syncCurrentNodeToStatus`) and broadcasts `board_changed`.
- **agent providers** (via strategy-objective): provider/profile/model selection + quota gating.
- Hidden coupling: `objective.md` is a *file*, not an import — the Conductor loop, the Monitor
  Butler, and the Bullseye all read/write it, so they co-change without a code edge
  (`strategy-objective.service.ts:81-97`, `monitor-butler.ts:42-44`).

## File topology

| Sub-responsibility | Implemented in | Layer |
|--------------------|----------------|-------|
| Cycle wiring, scheduling, event-trigger, re-entrancy, maintenance window, internal routes | `startup/monitor-setup.ts` | composition/startup |
| Per-candidate relaunch/merge/nudge/recover state machine | `startup/monitor-cycle.ts` | domain logic |
| Stuck-builder thresholds, session classification, zero-diff detection | `startup/monitor-cycle-rules.ts` | pure rules |
| Merge-with-fix-fallback, close-direct-as-done, status lookup | `startup/monitor-cycle-actions.ts` | domain actions |
| Auto-start fan-out: WIP capacity, dependency readiness, meta/feature filtering | `startup/monitor-auto-start.ts` | domain logic |
| Per-issue + SQL eligibility (feature exclusion) | `startup/monitor-eligibility.ts` | pure rules |
| Backlog refill (floor check, cooldown, host-issue, generation prompt) | `startup/monitor-backlog.ts` | domain logic |
| Pre-fan-out coupled-ticket contraction (opt-in) | `startup/monitor-contract.ts` | domain logic |
| Start Mode resolution (the SSOT gate) | `services/start-policy.service.ts` | policy resolver |
| Tunables + Strategy Bullseye + provider routing + objective.md rendering | `services/strategy-objective.service.ts` | policy/config |
| Out-of-process Conductor start/stop/cron-once | `services/conductor-control.service.ts` | OS process control |
| Read-only Conductor liveness/phase from disk | `services/orchestrator-monitor.service.ts` | observability |
| In-process LLM monitor (fresh SDK session/cycle) | `services/monitor-butler.ts` | LLM orchestration |
| One-switch Drive coherent-pref set + Drive records/retro | `services/drive.service.ts` | policy/lifecycle |
| Hands-off prerequisite gate + auto-repair | `services/drive-preflight.service.ts` | policy/validation |
| Structured drive-friction telemetry | `services/drive-obstacles.service.ts` | telemetry |
| Drive toggle + preflight REST | `routes/drive.ts` | transport |
| Conductor/tunables/schedule/orchestrator REST | `routes/board-monitor.ts` | transport |

## Risks, gaps & open questions

- **Self-HTTP asymmetry.** The in-flight candidate actions were migrated to an injected port
  (`monitor-cycle.ts:56-65`), but `runAutoStart` and `runBacklogEmptyStrategy` still
  `fetch('http://127.0.0.1:<port>/api/workspaces')` (`monitor-auto-start.ts:179,296`,
  `monitor-backlog.ts:204`). This is exactly the anti-pattern `packages/server/CLAUDE.md` warns
  against; it makes those paths depend on port availability and untestable without a live server.
  *(Verified from code.)*
- **Two cap regimes coexist.** The deterministic cycle hard-codes relaunch/merge caps of 2
  (`monitor-cycle.ts:36-37`) while NEW-start caps come from tunables (default 2). A maintainer could
  reasonably expect all three to be Bullseye-tunable; only `maxNewStartsPerCycle` is. *(Verified.)*
- **`monitorShouldRun` vs Start Mode.** The cycle still gates scheduling on the global
  `auto_monitor` OR any `board_autodrive_<id>` (`monitor-setup.ts:39-41`), while per-action
  auto-start consults `resolveStartPolicy`. A project set to Start Mode `monitor` via
  `start_mode_<id>` alone (without `board_autodrive` or global `auto_monitor`) may not cause the
  cycle to *schedule itself* — only to act once scheduled. **Inferred, unverified** — `monitorShouldRun`
  does not consult `resolveStartPolicy`, so whether such a project ever ticks depends on another
  project keeping the loop alive. Worth confirming against `deriveMode` (`start-policy.service.ts:103`).
- **Conductor liveness is file-mtime based** (`ALIVE_STALENESS_MS = 11 min`,
  `orchestrator-monitor.service.ts:22`) because `loop.pid` holds a git-bash PID, not a Windows PID.
  A loop that wedges but keeps a file handle warm could read as alive. *(Documented in-code.)*
- **`conductor-control.stopConductor` uses a broad PowerShell `taskkill` of every `loop.sh`**
  (`conductor-control.service.ts:114-119`). Intentional backstop, but it is the kind of broad kill
  the project's hard constraints otherwise forbid; it is scoped to `board-monitor.loop.sh` command
  lines, so it should not touch the server — *verify the regex can't match a sibling repo's loop.*
- **Monitor Butler resolves only ONE active project per cycle** (`activeProjectId`,
  `monitor-butler.ts:124-130`) — it cannot drive multiple projects, unlike the deterministic cycle
  which iterates all. If used as a general driver this is a silent single-project limitation.
- **Refill generation prompt asks an LLM to create tickets** with only soft constraints
  (`monitor-backlog.ts:60-87`); nothing validates the generated tickets are in-scope before they
  enter the backlog and become auto-start candidates next cycle. Possible self-amplifying drift.
