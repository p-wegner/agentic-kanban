# An external tracker as the source of truth — modernization plan for agentic-kanban

Goal: **an external issue tracker (Jira or Linear) becomes the source of truth for the board's
backlog.** Issues are created and edited there; the board projects them, writes board-side edits
through, and takes tracker-side changes back. Everything board-native that no tracker has a
concept of — workflow nodes, ticket groups, workspaces, agent sessions, artifacts — keeps working
unchanged.

Produced with the `modernization-plan` skill. This document is the *plan*; nothing in it has been
implemented. It **narrows and supersedes the tracker half** of
[`2026-08-26-team-capable-modernization-plan.md`](2026-08-26-team-capable-modernization-plan.md),
which bundled the same goal with PR/CI delivery and multi-developer operation. That plan is cited
here as recorded intent, and every claim taken from it was re-checked against the code at this
commit (§6); its delivery/CI half is explicitly **out of scope** and is not re-litigated.

## Provenance

- Repo `agentic-kanban`, metrics snapshot `code-metrics analyze` of commit **`af15952b78`**,
  2026-08-31 22:40 UTC, **180-day** window, **3,108 files** (1,808 production, 1,300 test,
  measured separately), tree clean at analysis time. Engine `code-metrics` 0.2.0.
  *The run was commissioned against `ab6d4eb21c`; another session merged
  `feature/ak-956-gate-tier…` into this checkout while the analysis ran, moving HEAD three
  commits to `af15952b78`. The snapshot is of `af15952b78` and every number below is from it.*
- **Import-graph completeness (`provenance.resolution_coverage`): TypeScript imports
  0.9993** — 8,656 of 8,662 in-repo specifiers bound (the 6 unresolved are build-output paths
  such as `../dist/cli/index.js`). Above the 0.95 bar, so the coupling, dependents and
  blast-radius numbers below are usable as stated rather than as floors. **The call channel is
  absent** (`calls: absent:no_call_resolution_channel`): dependent counts are *import* edges only,
  so any dynamic or string-dispatched call is invisible to them — where this plan cites a call
  count (broadcast sites, writer files) it comes from a grep in §6, not from the graph.
- Goal framing (§1, 11 capability rows) → **3 seams** → **3 read-only subagents**, run
  concurrently (`fleet gate --count 3` returned "room for 5"; the box then fell to ~0.6 GB usable
  and began paging with all three live, so 3 was the real ceiling, not 5).
- **Verification: 8 load-bearing claims re-checked by grep (§6)** — 5 confirmed, 2 corrected, and
  1 where this session's own counter-claim was **wrong and was reversed by the review** (F6). One
  external-API fact is carried as explicitly unverified.
- **Adversarial review: 1 round × N=1 fresh generalist reviewer** (§7) — 7 majors, **all 7
  integrated**, 2 of them re-shaping Phase 1. Every reviewer claim was grep-checked before
  integration. Six shortcomings the plan cannot fix are recorded in §8, one of which is a
  stop-gate.
- **NOT measured / not trustworthy here.** Class-level metrics are **UNMEASURED, not healthy**
  (0.5% of production SLOC sits in a behaviour-holding class — 49 classes vs 1,807 interfaces);
  no "0 god classes" claim appears in this plan. `--rework` reads **94.4%** and is a *convention
  artifact* of agent commits that use `fix:` for follow-ups (98–99% in every module) — it is
  cited nowhere as a quality signal, and its "where rework concentrates" table is useless here
  because every row reads 100%. The **scorecard's 26 targets are all defaulted** and calibrated
  on another codebase — advisory only. `--tangle` is history-dependent and not comparable across
  snapshots without `--history-ref`. Runtime behaviour, performance, and the actual Jira/Linear
  API semantics were **not** measured — the Linear case in particular is unexplored: no decision
  record, doc or line of code in this repo mentions Linear.

---

## 1. Goal as capability delta

Written before reading code; "today" from docs, CLAUDE.md and schema comments.

| # | Capability (target state) | Quality demanded | Seam | Today |
|---|---|---|---|---|
| C1 | Backlog items exist in the tracker; the board renders and works them | replaceable source of truth | S1 | board owns issues in `kanban.db`; `issues.externalKey`/`externalUrl` exist as an *optional link* only (`packages/shared/src/schema/issues.ts:22-31`) |
| C2 | `#N` keeps working everywhere while the tracker key is the real id | id translation, two-way | S1 | CLAUDE.md:18 — "`#N` always means a kanban issue number"; `#N` is load-bearing across agents, skills, commit messages |
| C3 | Status/lifecycle translates both ways | translation layer | S1 | decision 005: `statusId` is a derived legacy view, `currentNodeId`+`nodeType` is behavioural truth — two local state models to map |
| C4 | Every write to an issue goes through one port that can reach the tracker | strategy as port, single write authority | S1 | 14 production files write the `issues` table directly (§6 F1) |
| C5 | Changes made in the tracker reach the board | async-capable, observable | S2 | no ingest of any kind; WS push is board→client only |
| C6 | Both sides changed → a stated conflict rule | conflict rule | S2 | undefined; no version/etag column on `issues` |
| C7 | Tracker unreachable → the board still works, writes queue | offline-tolerant, outbox | S2 | CLAUDE.md:14 "Local only — no cloud"; offline is the normal state |
| C8 | Tracker credentials + project binding have a home | identity-aware, secret handling | S3 | no credential is persisted anywhere today (§3 S3) |
| C9 | Board-only fields keep a declared owner | ownership split declared | S1 | decision 015 ticket groups, workflow nodes, artifacts, time entries — no tracker equivalent |
| C10 | MCP/REST/WS consumers keep their contract while ownership moves | externally contracted | S1 | decision 010 "decompose contract symmetry"; the MCP surface is a published contract |
| C11 | A ticket an agent files lands in the tracker, not only locally | replaceable source of truth | S1 | `create_issue` allocates a local number and stops there |

No row is seamless. A candidate 4th seam, *status/workflow translation*, shares every file with
S1 and was folded into it (the skill's "two seams that always share files are one seam" rule).

## 2. What the metrics say about the ground we will build on

1. **The one kernel this goal must touch is the schema barrel.**
   `packages/shared/src/schema/index.ts` is the most depended-on file in the repo at **580
   importers** (`graph --stats`); `schema/issues.ts` itself has 13 direct importers, all of them
   other schema files. Any issue-model change is therefore **additive columns only** — a renamed
   or retyped column reaches 580 files.
2. **Two more kernels sit on the seam.** `services/board-events.ts` (94 production importers,
   §6 F4) and `repositories/preferences.repository.ts` (**102 importers**, `graph --stats`) are
   both where this goal naturally attaches — and both are load-bearing enough that only additive
   change is safe: a new event *reason*, a new preference *key*, never a signature change.
3. **The two highest-risk server files are exactly the two the goal must hook.**
   `startup/exit-workflow.ts` **risk 0.871** (#3 of 335 `refactor_first`, max-CC 30, 97
   commits/180d) and `services/issue.service.ts` **risk 0.776** (#12, max-CC 30, 48 functions).
   `candidates` prescribes `introduce_event` for both — exactly the refactor a write-through to a
   tracker needs, because without it the tracker write becomes a second inline call at each of
   their ~27 combined broadcast sites (§6 F8 note).
4. **The engine's computed splits are the ones to use, not invented ones.**
   `issue.service.ts` → 3 groups (`issueerror` / `issueid` / `statusname`, priority 0.689);
   `monitor-cycle.ts` (0.764) → 4 groups, one of which the engine names **`boardevents`** — i.e.
   the broadcast fan-out is a cohesive unit the engine can already see; `monitor-auto-start.ts`
   (0.768) → 6 groups; `project.service.ts` (0.844) → 3 groups, one of them `projectid`
   (`fetchBoardIssueIds`, `getBoard`, `getGraph`), which is the group a project↔tracker binding
   lands next to.
5. **The boundary the work will cross is `server ↔ shared` and it is the leakiest one measured.**
   `refactor --boundaries`: **co-change 0.49 over 9 file pairs**, weight 1,457 import edges,
   prescribed move `introduce_facade`. `shared` containment is **35%** (`--tangle`) — a change
   touching `shared` stays inside it only a third of the time. A new tracker type in `shared` is a
   two-module change by default; the plan declares the contract before both sides move.
6. **`mcp-server` is the least contained module at 23%** (`--tangle`) — 180 of its 234 changes
   spilled into another module. It is also one of three **hidden dependencies**: `mcp-server ↔
   server` co-changes 205 times with **no import edge** (`--module-crime`), as do `client ↔
   server` (1,051) and `client ↔ mcp-server` (123). These are contracts kept in sync by hand —
   and the MCP server genuinely runs its own drizzle client against the same DB (§6 F2), so
   "route all writes through one port" cannot be done inside the server process alone.
7. **The wire contract already shows as temporal coupling.** `routes/issues.ts ↔
   shared/types/api.ts`: **58 shared commits, degree 30%** (`--coupling`, the #2 pair in the
   repo); `mcp-server/tools/update-issue.ts ↔ shared/schema/issues.ts`: 18 commits / 40%. Adding
   fields to the issue DTO is a known three-place edit, not a surprise.
8. **The centre of gravity is 0.447 and 36% of decision points sit in adapters**
   (`--layer-fit`, 🔴 and 🟡 respectively on the scorecard). For this goal that matters in one
   concrete way: `client` has a centre of gravity of **0.210** with 13,128 decision points, so
   status/field semantics duplicated into the client is the default failure mode — the status map
   must live in `shared`, where the existing `TERMINAL_STATUS_NAMES` consolidation already lives.
9. **Dependency ground is clean.** 50 dependencies, 1 upgrade blocker, node >= 22 supported to
   2027-04-30, no EOL/abandonment finding (`--deps`). Adding an HTTP client for the tracker is a
   genuinely new dependency edge — there is no existing outbound-SaaS HTTP client to reuse
   (§6 F5).

## 3. Seams and their components

### S1 — Issue source of truth, its writers, and the external contract

| Component | Files | Role | What changes for the goal | Class | Size |
|---|---|---|---|---|---|
| Issue schema | `packages/shared/src/schema/issues.ts` | owns the row, `#N`, `externalKey`/`externalUrl` | **additive**: split `source_key` out of `externalKey` (the #201 debt the schema comment itself prescribes, `issues.ts:24-29`), add `externalId`/`syncedAt`/`syncVersion` | kernel (via `schema/index.ts`, 580) | M |
| `issue.service.ts` | `packages/server/src/services/issue.service.ts` | the *intended* write API; a large factory closure (48 functions) | becomes the tracker write gate; take the engine's 3-way split first | hot-on-seam, risk 0.776 + 2 prescribed moves | L |
| Status write sites | `workflow-engine/status-transition.ts:87` (`transitionIssueStatus`, referenced from 19 production files), **plus three writers that bypass it**: `workflow-engine/transitions.ts:190` and `:244`, `workflow-engine/workspace-init.ts:94`, and `workflow-engine/status-sync.ts:152` | status change is *concentrated* but **not** funnelled through one function (§6 F6 — the review refuted this plan's own first reading) | ~4 sites emit an additive `issue_status_changed` payload event; the tracker write-back subscribes | cold-on-seam (mechanical) | M |
| Status view / node mapping | `shared/src/lib/status-view.ts:11` (`TERMINAL_STATUS_NAMES`), `workflow-engine/node-config.ts` (`deriveStatusName`), `workflow-engine/status-sync.ts` | the local status semantics | gains a declared `status_map` (tracker state ↔ node type), in `shared` | cold-on-seam | M |
| The 24 direct writers | **14 via the local-import form** — `repositories/{issue-service, issue-ai, backlog-snapshot, auto-start-skip, project-registration, scheduled-run-query, spec-tasks-materialization, start-scoring, voice-capture, workspace-crud, issue/cli-commands}.repository.ts`, `startup/monitor-backlog.ts`, `startup/workflow-node-divergence-reconciler.ts`, `db/builtin-workflows.ts` — **plus 10 via the `schema.issues` form**: the five MCP write tools, `shared/src/lib/cascade-delete.ts`, and the four workflow-engine files above | write the `issues` table without passing `issue.service.ts` (§6 F1) | each routes through the gate, or is declared **board-local, never synced**, or (the four workflow-engine files) is declared the *interior* of the status gate rather than a bypass — all three states recorded in a shrink-only ratchet | contract (the missing gate) | L (breadth) |
| MCP issue surface | `packages/mcp-server/src/tools/*` — 39 of 94 tool files touch the issues table, **5 of them write it** (`create-issue`, `create-issues-batch`, `create-sub-issue`, `update-issue`, `contract-coupled-issues`) | a separate process with its **own drizzle client** (§6 F2) | writes must reach the same gate; a second process means the gate is a shared table or HTTP, not a function call | contract; module containment 23% | L |
| CLI issue surface | `packages/server/src/cli/commands/issue.ts` + `repositories/issue/cli-commands.repository.ts` | third write path | same | contract | M |
| Board event bus | `packages/server/src/services/board-events.ts` (94 importers) | per-project WS pub/sub; **invalidation-only for issue events** (§6 F4) | the outbox subscribes; new reasons are additive | kernel | S |
| Issue DTO + REST | `packages/shared/src/types/api.ts` ↔ `packages/server/src/routes/issues.ts` (**risk 0.775**, #13 of 335, 189 commits/180d; the pair co-commits 58 times at degree 30%) | the wire contract and the HTTP write surface | new sync fields declared once; the route gains no logic of its own | hot-on-seam | S |
| Board-only data | `schema/tags.ts`, `issue-artifacts.ts`, `issue-time-entries.ts`, `issue-dependencies.ts` (incl. the `coupled_with` edge, decision 015), `workflows.ts`, `drives.ts`, `milestones.ts`, `showdowns.ts`, `workspace-issue-members.ts`, `plugin-loop-events.ts` | concepts no tracker has | declared **board-owned, never synced** | cold-on-seam | S (declaration) |

### S2 — Sync, ingest, background execution, offline tolerance

| Component | Files | Role | What changes for the goal | Class | Size |
|---|---|---|---|---|---|
| Monitor timer | `startup/monitor-setup.ts:617` (self-rearming `setTimeout`), `:694` (30 s state sync), `:699-706` (5-min sweep) | the repo's one general periodic engine | a tracker pull pass piggybacks here. **Precedent is explicit**: `monitor-setup.ts:699-706` piggybacks two unrelated jobs on one timer citing decision 014 rather than adding a third | hot-on-seam (`monitor-cycle.ts` 0.764) | M |
| Reconciler family | ~16 `startup/*-reconciler.ts` (e.g. `workflow-node-divergence-reconciler.ts`) | each self-heals one specific drift between two state stores on a periodic sweep | **this is the shape of a tracker→board import**; write the pull as one more reconciler, not as a new subsystem | cold-on-seam | M |
| Exit workflow | `startup/exit-workflow.ts` | session-exit dispatcher; 17 `boardEvents.broadcast` sites; writes `issue_updated` | status changes produced here must reach the tracker | hot-on-seam, **risk 0.871 — the highest on any seam** | L |
| Retry/backoff precedent | `schema/workspace-merge-backoff.ts:26-45` | one row per workspace: `failures`, `signature`, `nextRetryAt`, `error`; deleted when the block clears | **the exact shape to copy for `tracker_outbox`** — there is no outbox or job table in the schema today (§6 F7) | contract (new) | M |
| Outbound HTTP | `shared/src/lib/outbound-webhook.ts:57`, `services/outbound-webhook.service.ts` | the only outbound-HTTP mechanism | **unusable**: it rejects any non-loopback host and is fire-and-forget with no timeout or retry (§6 F5). The tracker client is net-new | — | M |
| Remote-unreachable doctrine | `services/agent-remote.service.ts` (risk 0.681) | worker detach/reconnect grace rather than fail | the behavioural template for "tracker unreachable": mark stale, keep local authoritative, reconcile on reconnect | cold-on-seam | S (pattern only) |
| Versioning | `schema/issues.ts:16-17` (`createdAt`/`updatedAt`/`statusChangedAt`) | no version, no etag, no CAS anywhere on `issues` | a conflict rule needs new columns; it has nothing to attach to today | kernel (additive) | S |

### S3 — Configuration, secrets, and the project↔tracker binding

| Component | Files | Role | What changes for the goal | Class | Size |
|---|---|---|---|---|---|
| Per-project preference convention | `shared/src/lib/dynamic-preference-keys.ts` (`PROJECT_SCOPED_KEY_PREFIXES`), `shared/src/lib/checked-preference-write.ts`, `shared/src/lib/cascade-delete.ts:217-224` | `<prefix>_<projectId>` keys, centrally validated, swept on project delete | the binding (which tracker project, which field map) is **one new prefix in an existing allow-list**, inheriting validation and cleanup free | cold-on-seam | S |
| Preferences store | `repositories/preferences.repository.ts` (**102 importers**) | flat KV in `kanban.db` | additive key only | kernel | S |
| Project identity | `repositories/project.repository.ts`, `services/project.service.ts` (risk 0.844, computed split group `projectid`) | `repoPath`-keyed identity, `deduplicateProjects()` | optionally an additive `trackerKey`; identity itself does not change | hot-on-seam | M |
| Secrets | **nothing today.** Nearest precedents: `lib/remote-spec-env.ts:30-72` (`REMOTE_SPEC_ENV_ALLOWLIST` + `looksSecretEnvKey`, decision 012 — board credentials are *never* sent to a worker); worker bearer tokens stored as SHA-256 hashes and paired into `~/.agentic-kanban/worker-state.json` (`docs/worker-fleet.md:130-133`) | — | a tracker token would be **the first credential this product ever persists**. It goes in the environment or the OS keychain, never in `kanban.db`, and never into a worktree's `CLAUDE.local.md` — which the board *generates and hands to the coding agent* (`shared/src/lib/ticket-context.ts`), i.e. the one file guaranteed to be read by an AI agent | contract (new) | M |
| Settings UI | `client/src/components/SettingsPanel.tsx` (**risk 0.906, the #1 hotspot in the repo**, 545 lines), tab table `client/src/lib/settings-shared.ts:25-36` | tabbed settings | **one line in the tab table plus one `<TrackerSettings/>` render line.** The extraction pattern is not a proposal — `components/settings/` already holds **19 extracted tab components** (§6 F8). The god-file is a router; do not refactor it for this | hot-off-seam in practice | M (new component), S (the panel edit) |
| Plugin mechanism | `services/plugin.service.ts` (risk 0.736), `plugins.repository.ts`, manifest example `packages/server/plugins/app-runner/kanban-plugin.json`, enable key `plugin_enabled_<slug>_<projectId>` | installable per-project extensions with their own views and scripts | a **serious alternative host** for the whole integration — see §9, open decision D1 | hot-on-seam if chosen | L |

## 4. Do-not-touch (hot, off-seam)

Highest-risk files that **no capability row reaches**. Listed with their numbers so nobody
"fixes them while there" — touching them adds risk to this programme and buys it nothing.

| File | Risk | Why it is off-seam |
|---|---|---|
| `client/src/components/Layout.tsx` | 0.884 | app chrome; no issue ownership |
| `client/src/components/WorkspacePanel.tsx` | 0.869 | workspace lifecycle, not the backlog |
| `server/src/services/workspace-merge.service.ts` | 0.843 | delivery — explicitly out of this goal's scope |
| `server/src/server-start.ts` | 0.838 | boot wiring |
| `client/src/components/BoardToolbar.tsx` | 0.831 | filters/view state |
| `client/src/components/ButlerView.tsx` | 0.776 (4 computed split groups) | assistant UI |
| `server/src/routes/workspaces.ts` | 0.776 | workspace API |
| `client/src/components/DiffViewer.tsx` | 0.736 | diff rendering |
| `server/src/services/session-manager/session-lifecycle.ts` | 0.731 | agent sessions |
| `server/src/services/merge-queue.service.ts` | 0.688 | delivery |
| `client/src/components/SettingsPanel.tsx` | **0.906** | *on* the seam but only by two lines; its 545-line body is do-not-touch for this programme |
| `client/src/components/IssueDetailPanel.tsx` / `IssueCard.tsx` | 0.800 / 0.769 | they render `externalKey` today and will render sync state; **display-only edits**, no logic, no refactor |

## 5. Phases

**Sequencing rationale, stated up front because it departs from the default skeleton.** The
standard cut is *ports first, adapter second*; this plan ships a small, real *seam* and a real
adapter together in Phase 1, then does the expensive structural work in Phase 2 against known
tracker semantics instead of ahead of them.

An earlier revision justified that by claiming status change "already funnels through a single
function", `transitionIssueStatus`. **That claim was wrong and the adversarial review refuted it**
(§6 F6, §7 finding 1): `workflow-engine/transitions.ts:190` and `:244`,
`workflow-engine/workspace-init.ts:94` and `workflow-engine/status-sync.ts:152` write
`issues.currentNodeId` directly, and per decision 005 the node — not `statusId` — is the
behavioural truth, so hooking only `transitionIssueStatus` would have missed exactly the
workflow-driven transitions an agent produces. The rationale is now the opposite and smaller: the
status seam does not exist, but creating it is **mechanical and cheap** — an additive
payload event emitted from about four write sites onto the event bus the repo already has. That
extraction is therefore pulled *into* Phase 1 as its enabling item, not deferred to Phase 2. What
is also **not** deferred is the `externalKey` overload: a correctness prerequisite, and item 1.

### Phase 0 — Decide and protect (no behaviour change)

**Goal.** Make the decisions that cannot be made from data, and put a net under the files the
next phases cut into.

Work items:
1. **(S)** Decision record `018-external-tracker-as-source-of-truth.md`: which fields the tracker
   owns, which stay board-owned (the §3 board-only list), sync direction per field, the conflict
   rule, and what "unreachable" means. **It must explicitly amend CLAUDE.md:14 "Local only — no
   cloud/multi-tenant/OAuth"** — a token-based tracker integration is a network dependency that
   line forbids as written. Silently excepting it is not allowed by this repo's own conventions.
2. **(M)** Decision record for the credential, and the code that makes it true. **Never
   `kanban.db`**, never a worktree `CLAUDE.local.md` (`shared/src/lib/ticket-context.ts:376` —
   the board writes that filename into every worktree for the agent to read). Two enforcement
   points, both required, because "put it in the environment" is **not** by itself safe here:
   (a) extend `looksSecretEnvKey`'s posture in `packages/server/src/lib/remote-spec-env.ts:62-72`
   so the token can never cross to a fleet worker (decision 012's rule applied to a new secret);
   (b) **scrub the token from the environment the board hands to a spawned coding agent**, with a
   test — the board spawns the agent as a child process, and a child inherits `process.env` by
   default, so an env-var token is otherwise readable by every agent the board starts. If (b)
   cannot be made to hold, the environment option is dropped and the OS keychain is mandatory.
3. **(M)** Characterisation tests for `services/issue.service.ts` and `startup/exit-workflow.ts`
   covering the paths Phase 2 splits — at minimum every function in the engine's three computed
   groups, and the triggering conditions of the 17 broadcast sites.
4. **(S)** A **shrink-only writer ratchet**, following the repo's own established pattern
   (`packages/shared/__tests__/wire-dto-single-declaration.test.ts`): the **24** files in §3 are
   the grandfathered set of direct `issues`-table writers; the test fails if a 25th appears or if
   a listed entry is stale. **It must scan for both spellings** — `.insert|update|delete(issues)`
   *and* `.insert|update|delete(schema.issues)`. Scanning only the first form is what made an
   earlier revision of this plan under-count by 10 files, and the 10 it missed are the
   status-critical ones (§6 F1).
5. **(S)** Pin `code-metrics baseline` at the Phase-0 head sha.
6. **(S)** Answer **D1 (core or plugin)** and **D2 (Jira or Linear)** from §9. They are not
   documentation: D1 changes the size of nearly every Phase-1 item and D2 determines the only
   client that gets built.

Exit criteria: both decision records exist **and CLAUDE.md:14 is amended**; D1 and D2 are
answered in writing; the writer ratchet test exists and passes at 24 with both grep forms;
`compare --history-ref <phase0-sha>` shows no file's risk changed (nothing has been refactored).
**Stop-gate: if the CLAUDE.md:14 amendment is refused, the programme ends here.** That line is
listed under "Hard Constraints — never violate"; a plan cannot amend it by its own decision
record, and there is no version of this goal that keeps the board off the network.
Risks: the decisions are the real blocker and they are not the implementer's to make — see §9.
Do-not-build here: no client, no schema change, no UI.

### Phase 1 — One tracker project on one board, flagged and reversible

**Goal — the first user-visible outcome.** A developer points the board at a Jira/Linear project,
sees that backlog on the board, starts an agent on one of those tickets, and the ticket's status
moves in the tracker. One direction of truth (tracker → board) plus one field back (status).
Everything sits behind `tracker_binding_<projectId>`; no binding = today's behaviour, byte for
byte.

Work items:
1. **(M) Pay the `externalKey` debt first.** Additive migration: a new nullable `source_key`
   column; move the `plugin-loop:<slug>:<loop>:<unit>` and `onboarding:*` machine identities off
   `external_key` onto it (`shared/src/lib/plugin-keys.ts`, `services/plugin/loop-unit-tickets.ts`,
   `onboarding-plan.ts`), keep the prefix-LIKE index working, and add
   `unique(project_id, external_key) where external_key is not null`. The schema comment
   (`issues.ts:24-29`) prescribes exactly this split; without it a real tracker key can collide
   with a synthetic one, and the column has **no uniqueness constraint** today (§6 F3).
2. **(M)** Additive columns `externalId`, `syncedAt`, `syncVersion` on `issues`. Additive only —
   `schema/index.ts` has 580 importers.
3. **(S)** Register `tracker_binding` (and `tracker_field_map`) in `PROJECT_SCOPED_KEY_PREFIXES`
   (`shared/src/lib/dynamic-preference-keys.ts`); cascade-delete and write validation come free.
4. **(L)** `packages/server/src/services/tracker/` — one client for the chosen tracker, reading
   its token from the environment. **One tracker, not an interface with one implementation** (see
   the do-not-build note). Timeout, bounded retry, and a `detached` state modelled on
   `agent-remote.service.ts`'s reconnect grace, not on `outbound-webhook.ts`, which is
   loopback-only and cannot reach a SaaS host at all (§6 F5).
5. **(M)** A **pull reconciler** in `startup/`, one more member of the existing ~16-reconciler
   family, piggybacked on the monitor timer (`monitor-setup.ts:699-706` precedent, decision 014
   — do not add a timer). It imports new tracker issues as local rows with `externalKey` set, and
   on later passes updates title/description **subject to two hard guards, both in Phase 1 and
   not deferred to the Phase-3 conflict rule**: it **never restatuses an issue that has an open
   workspace** (board-owned while claimed), and it skips any row whose `syncedAt` is not older
   than the tracker's `updated` timestamp. Without these, a 30 s/5 min poll races every board-side
   transition and can overwrite the state of a ticket an agent is working. It must also declare a
   pagination and rate-limit budget — a first sync of a large project is not one request.
6. **(M)** A **declared `status_map`** in `shared` keyed on `workflow_nodes.nodeType` — the
   behavioural truth per decision 005 — **not** on `statusId`, and **not** in the client, whose
   centre of gravity is already 0.210. It lives next to `TERMINAL_STATUS_NAMES` and
   `deriveStatusName`.
7. **(M) The enabling seam: make the status change an event.** Emit an additive
   `issue_status_changed { issueId, nodeType, statusName, externalKey }` payload event on the
   existing `board-events.ts` bus from the ~4 real status write sites —
   `workflow-engine/status-transition.ts:87`, `transitions.ts:190` and `:244`,
   `workspace-init.ts:94`, `status-sync.ts:152`. This is mechanical, additive, and it is the only
   honest gate: hooking `transitionIssueStatus` alone misses the workflow-driven transitions that
   agent work actually produces (§6 F6). No new bus — `board-events.ts` already carries
   payload-bearing variants for activity, stats, todos and approvals.
8. **(M)** Status write-back as **one subscriber** to that event. Local write first, tracker call
   after, failure logged and surfaced — deliberately no outbox yet (Phase 2), so early failures
   are visible rather than buried in a queue.
9. **(M)** `TrackerSettings.tsx` under `client/src/components/settings/`, one tab entry in
   `settings-shared.ts`, one render line in `SettingsPanel.tsx`. Nothing else in that file.
10. **(S)** Display of `externalKey`/sync state in `IssueCard.tsx`/`IssueDetailPanel.tsx` —
    rendering only.
11. **(S)** Kill switch: unset the binding preference → the reconciler stops and write-back stops.
    Imported rows must be **tagged as tracker-imported and listed**, so unbinding is a revert the
    operator can complete, not a silent pollution of the local backlog with orphaned rows.
12. **(S)** `#N` for imported issues: Phase 1 mints a local number for every imported ticket, so
    capability C2 (`#N` alongside the tracker key) is exercised **here**, not in Phase 3. State
    the rule — `#N` remains the agent-facing handle, the tracker key is displayed beside it — and
    make sure `pnpm cli -- issue get <N>` resolves an imported ticket.

Exit criteria (each re-measurable, and each able to *fail*):
- The writer ratchet still reads **24** under both grep forms — Phase 1 adds no new direct writer,
  and the four workflow-engine status writers are reclassified, not multiplied.
- `code-metrics surface` shows the new `services/tracker/` module exported at exactly one place,
  and `graph --dependents-of` that entry point lists no file under `packages/client/`.
- `compare --history-ref <phase0-sha>`: no file that Phase 1 did not touch changes risk class, and
  `SettingsPanel.tsx` (0.906) does not rise — this can fail, because item 9 does edit it.
- Behavioural, and these are the ones that matter: with the binding unset the full suite passes
  unchanged; with it set against a tracker sandbox, an imported ticket moved **by an agent through
  the workflow-node path** (not just by a manual status edit) moves in the tracker; a ticket with
  an open workspace is **never** restatused by a reconciler pass, asserted by a test that runs a
  pull while a workspace is open.

*Two criteria from an earlier revision were deleted because they could not fail: "`dependents-of
issues.ts` unchanged at 13" (all 13 are schema siblings, so an added column can never move it) and
"`issue.service.ts` risk has not increased" (the phase does not touch that file). A criterion that
cannot fail is decoration.*

Risks: the pull reconciler is a periodic poll and will double-import if it is not re-entrant —
this repo has already been bitten by exactly that (`monitor-setup.ts:625-627`, #349: an unguarded
30 s poll stacked ~8 concurrent scans). Guard it the same way.
Do-not-build in this phase: **no `IssueTrackerPort` interface.** One tracker will be chosen (§9
D2); an interface with a single implementation and no second one funded is speculative
generality. Also: no outbox, no two-way field sync beyond status, no MCP/CLI routing change, no
general conflict rule (the two Phase-1 guards in item 5 are deliberately narrower than one).
**Cheaper alternative considered and rejected:** widening `outbound-webhook.ts:57`'s loopback
allow-list behind the binding, instead of a new client. Rejected — that path is fire-and-forget
with no timeout, no retry and no response handling (`shared/src/lib/outbound-webhook.ts:65-73`),
so it can push a status but can never *read* the tracker, which capability C5 requires; and
loosening a security check that exists to keep the board off the network is the wrong place to
spend the CLAUDE.md:14 amendment.

### Phase 2 — Make the write paths honest (behaviour-preserving)

**Goal.** Turn "the tracker write happens where we remembered to put it" into "the tracker write
is a subscriber to a fact the system already publishes", and close the bypasses.

Work items:
1. **(M)** `tracker_outbox` table, shaped after `workspace_merge_backoff` (`failures`,
   `signature`, `nextRetryAt`, `error`, row deleted on success). Local write first, then enqueue.
2. **(L)** Apply the engine's `introduce_event` to `startup/exit-workflow.ts` (risk 0.871) and
   `services/issue.service.ts` (0.776) so the outbox enqueues from *one* subscriber rather than
   from inline calls. **Honest sizing caveat:** the "17 and 10 broadcast sites" figures come from
   the seam reports' greps and were not independently re-counted in this run (§6); the engine's
   own `introduce_event` priorities (0.58 and 0.46) are computed from *cross-module call counts*
   (8 and 5), not from those site counts. Re-count before sizing the ticket.
3. **(L)** Apply the engine's computed `split_responsibility` on `issue.service.ts` — the three
   groups `issueerror` / `issueid` / `statusname`, all verified to be real functions inside the
   single `createIssueService()` closure — so the write gate is a small unit, not a 987-line
   factory.
4. **(L)** Walk the 24 direct writers: each either routes through the gate, or gets an explicit
   `board-local, never synced` declaration in the ratchet with a one-line reason, or is declared
   part of the gate's interior (the four `workflow-engine/*` status writers, once item 7 of
   Phase 1 has them emitting the event).
5. **(M)** **MCP** runs in its own process with its own drizzle client (§6 F2), so the gate cannot
   be a function call for it: either it enqueues into the same `tracker_outbox` table (the table
   *is* the port) or its writes move behind HTTP. Pick one and record it — the hidden dependency
   `mcp-server ↔ server` (205 co-changes, no import edge) is the debt being paid down.
   **The CLI is a different problem** and must not be lumped in: it lives at
   `packages/server/src/cli/` and shares the server's repositories, so for it the gate genuinely
   can be a function call — the fix is routing `repositories/issue/cli-commands.repository.ts`
   through the gate, not a queue.

Exit criteria:
- `compare --history-ref <phase2-start-sha>`: `services/issue.service.ts` **leaves
  `query --class refactor_first`** (risk below the class threshold), measured after the compare so
  the refactor's own churn is frozen out.
- `candidates` no longer prescribes `introduce_event` for `exit-workflow.ts`.
- Writer ratchet: writers reaching the table **without** passing the gate go **24 → ≤ 5**; every
  remaining entry carries its declaration (gate interior / board-local) and a reason.
- `--module-crime` "Hidden dependencies": the `mcp-server ↔ server` pair either gains an import
  edge or its Jaccard (0.098 today) does not rise.
- `refactor --boundaries`: `server ↔ shared` co-change **≤ 0.49** — **but only measured with
  `--history-ref <phase2-start-sha>` passed to both snapshots.** Boundary co-change and `--tangle`
  containment are computed from reconstructed change sets and are not comparable between raw
  snapshots (the engine says so itself, and so does this plan's Provenance). Without the
  `--history-ref` this criterion is meaningless and must be dropped rather than reported.

Risks: this is the phase that can break behaviour while claiming not to. The Phase-0
characterisation tests are the only thing standing between the split and a silent ordering change
in `exit-workflow.ts`.
Do-not-build: no new features; no second event system beside `board-events`.

### Phase 3 — Two-way, with a stated conflict rule

Work items: field write-back beyond status (title, description, assignee) through the outbox;
tracker→board ingest of the same fields; the conflict rule from Phase 0's decision record,
implemented on `syncVersion`/`syncedAt` with a **stated** winner per field; offline drain when the
tracker returns; the board's own `create_issue` creating in the tracker (C11) so the local number
becomes an alias and `#N` keeps resolving (C2).
Exit criteria: a scripted divergence test (edit both sides while disconnected, then reconnect)
produces the documented outcome and the outbox drains to empty; `scorecard`'s composite does not
fall below its Phase-2 value (advisory — all its targets are defaulted); `--tangle` containment of
`mcp-server` (23% today) does not fall, **measured with `--history-ref` on both snapshots** for
the reason given in Phase 2.
Risks: Jira Cloud REST v3 offers no conditional update, so compare-and-swap against the tracker is
not available — the conflict rule must be resolvable with last-writer-wins plus an audit trail, or
with an atomic claim held somewhere the board controls. **This constraint is carried over from the
prior plan and was NOT verified in this run** (§6, F-prior).
Do-not-build: no bidirectional sync of board-only concepts (workflow nodes, ticket groups,
artifacts, time entries) — declared board-owned in Phase 0 and staying that way.

### Phase 4 — Decommission and harden

Remove the flag: a bound project's tracker binding becomes ordinary configuration, while an
unbound project keeps the fully local behaviour (that is a product guarantee, not a legacy path).
Turn the Phase-0 ratchet and the Phase-1 exit criteria into enforced rules — `analyze
--fail-on-violations` against `.codemetricsrc [architecture]` rules (the file exists at the repo
root, so this is configuration, not new infrastructure) that forbid a new direct `issues` writer
and forbid `client` importing the tracker client.
**Where these run is an open question, not an assumption.** CLAUDE.md says "PR creation skipped —
manual merge only" and this repo has no CI pipeline; the natural home is therefore the existing
**pre-merge gate** (`services/pre-merge-gate.service.ts`, which already runs a declared always-run
guard set via the `// @gate:always-run` marker) rather than a CI job that does not exist. Decide
before Phase 4 starts.
Exit criteria: 0 violations; the writer ratchet holds at its Phase-2 number for a full release
cycle with no regressions.

## 6. Verification of the load-bearing claims (step 6a)

| # | Claim | Check performed | Verdict |
|---|---|---|---|
| F1 | "~15 writer surfaces, 9 bypass `issue.service.ts`" (seam report) | first pass: `grep -rn "\.\(insert\|update\|delete\)(issues)"` over `packages/*/src`, tests excluded → 14 files. **The adversarial review caught that this pattern misses the `schema.issues` spelling**; re-run with both patterns → **24 production files** | **corrected twice → 24.** The first correction (14) was itself under-counted by 10: the five MCP write tools, `shared/src/lib/cascade-delete.ts`, and the four `workflow-engine/*` files — the last of which are precisely the status-critical ones. A ratchet built on the single-pattern grep would have passed while a `schema.issues` writer landed |
| F2 | "MCP reaches the DB directly, not over HTTP" | `packages/mcp-server/src/tools/create-issue.ts:1-6` takes `db`/`schema` from `./deps.js` and `nextIssueNumber` from `../db-utils.js`; no `fetch(` anywhere under `tools/` | **confirmed.** Refined: 39 of 94 tool files reference the issues table, **5 write it** — the report's "≥16 tools" conflated read and write |
| F3 | "`externalKey` is overloaded and has no uniqueness constraint" | `packages/shared/src/schema/issues.ts:22-31` (the KNOWN DEBT #201 comment, verbatim) and `:55-66` — `uniqueIndex` exists for `(project_id, issue_number)` only; `(project_id, external_key)` is a plain `index` | **confirmed**, and the schema itself prescribes the `source_key` split |
| F4 | "the board event bus is invalidation-only for issue events" | `services/board-events.ts:150-160` — `broadcast(projectId, reason)` sends `{type:"board_changed", projectId, reason}`; payload-carrying variants exist only for activity/stats/todos/approvals/plugin-gate | **confirmed.** Importer count measured at **94** production files (the two seam reports said 109 and 87; both counted differently, including tests) |
| F5 | "the only outbound-HTTP mechanism cannot reach a SaaS host" | `shared/src/lib/outbound-webhook.ts:57` — `if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return null` | **confirmed** |
| F6 | "there is no single write gate for issues" — and this plan's first counter-claim, that `transitionIssueStatus` *is* a single authority for status | round 1: `grep -rn "export .*transitionIssueStatus"` → `shared/src/lib/workflow-engine/status-transition.ts`, referenced by 19 production files. Round 2 (after the review challenged it): `grep` for `update(schema.issues)` under `workflow-engine/` → `transitions.ts:190`, `transitions.ts:244`, `workspace-init.ts:94`, `status-sync.ts:152` all write `issues.currentNodeId` **without** calling it | **the plan's own counter-claim is REFUTED.** Counting importers of an exported function can never establish exclusivity, and it did not. Status writes are *concentrated in ~4 sites*, which is not the same thing as *funnelled through one*. The original seam-report claim ("no single write gate") therefore stands for status as well as for content. §5's sequencing rationale was rewritten because of this |
| F7 | "no outbox / queue / job table exists" | listing of `packages/shared/src/schema/` plus a grep for a `sqliteTable("…outbox/queue/job` declaration | **confirmed**; `workspace_merge_backoff` (`:26-45`) is the nearest shape and is single-purpose |
| F8 | "`SettingsPanel.tsx` is a barrier and `PluginsSettings` is the escape hatch" | `SettingsPanel.tsx` is 545 lines; `client/src/components/settings/` contains **19 extracted tab components** | **corrected — the claim is much weaker than stated.** Extraction is not an escape hatch, it is the file's normal structure. The panel is a router; adding a tab is routine work |
| F-prior | "Jira Cloud REST v3 has no conditional update" (from the prior plan) | **not checked** — an external API fact, and this run made no network calls | **unverified**, carried as a Phase-3 risk, not as a fact |

Two counts worth recording rather than asserting loosely. Status-name literals appear in **99
production files** (`"Done"`/`"Cancelled"`/`"In Progress"`/`"Todo"`, tests excluded); a seam
report estimated "~80, approximate". It is cited only as a scale indicator — many are UI labels,
and `TERMINAL_STATUS_NAMES` (`shared/src/lib/status-view.ts:11`) is the one place the semantics
live. Broadcast-site counts (17 in `exit-workflow.ts`, 10 in `issue.service.ts`, 21 in
`monitor-cycle.ts`) come from the seam reports' own greps and were **not** independently
re-counted here; treat them as approximate, and note the engine's `introduce_event` priorities
(0.58 / 0.46) are computed from cross-module call counts, not from these.

## 7. Adversarial review (step 6b)

One round, **N = 1 generalist reviewer**, fresh subagent with the plan, the repo, the metric files
and the rubric, and none of this session's reasoning. Every major finding below was re-checked by
grep here before integration — the two most serious ones were confirmed exactly.

Verdicts: **R1 WEAK** (metric quotations all verified correct; the one number turned into an
enforcement mechanism was wrong) · **R2 WEAK** (right shape, but the Phase-1 demo would not have
fired for workflow-driven tickets) · **R3 PASS** ("the plan's strongest section" — every refusal
anchored in a verified precedent) · **R4 WEAK** (CLAUDE.md:14 named but treated as amendable with
no stop-gate; the credential leaks to spawned agents) · **R5 WEAK** (hooked the derived legacy
view instead of the behavioural truth decision 005 defines) · **R6 PASS** (each structural change
carries a baseline and a rejected cheaper alternative) · **R7 WEAK** (two Phase-N items needed in
N−1; several exit criteria could not fail).

| # | Major finding | Fate | Where in the plan |
|---|---|---|---|
| 1 | The sequencing rationale rested on a false claim — status change does **not** funnel through `transitionIssueStatus`; `transitions.ts:190/:244`, `workspace-init.ts:94`, `status-sync.ts:152` bypass it, and per decision 005 the node is the truth, so Phase 1 would have missed every agent-driven transition | **integrated** (confirmed by grep) | §6 F6 verdict reversed; §5 rationale rewritten; §3 S1 row replaced; the event extraction moved *into* Phase 1 as item 7, with write-back as its subscriber (item 8) |
| 2 | The writer ratchet grandfathered a false baseline — the grep missed the `schema.issues` spelling and therefore 10 files, the status-critical ones among them | **integrated** (confirmed: 24, not 14) | §3 S1 row, §6 F1, Phase-0 item 4 (both patterns mandated), Phase-2 item 4 and its exit criterion |
| 3 | Phase 1 could overwrite a running agent's ticket state — a poll importing status with the conflict rule deferred to Phase 3 races every board-side transition | **integrated** | Phase-1 item 5 gains two hard guards (never restatus an issue with an open workspace; `syncedAt` gating) and a Phase-1 exit criterion asserting it under test |
| 4 | It reversed a prior plan's already-integrated review finding (event extraction first) without saying so, justifying the reversal with the false claim in finding 1 | **integrated** | §5 now restores extraction-first and states plainly why the earlier rationale was wrong; this row is the record |
| 5 | The credential has no safe home — "the environment" is inherited by the coding agents the board spawns as child processes; `remote-spec-env.ts` guards only the *worker* boundary, and lives in `packages/server/src/lib/`, not `shared` | **integrated** | Phase-0 item 2 rewritten: two enforcement points, a spawn-env scrub with a test, or the keychain becomes mandatory; path corrected |
| 6 | Several exit criteria could not fail — `dependents-of issues.ts` stays 13 for any additive change; a risk criterion on a file the phase does not touch; tangle/boundary thresholds compared across raw snapshots the engine says are not comparable | **integrated** | Phase-1 criteria rewritten (two deleted with the reason stated inline); Phase-2 and Phase-3 boundary/tangle criteria now require `--history-ref` on both snapshots or must be dropped |
| 7 | The plan is sized and sequenced on two undecided forks (D1 core-vs-plugin, D2 Jira-vs-Linear) that are not in any phase's exit criteria, and there is no stop-gate if the CLAUDE.md:14 amendment is refused | **integrated** | Phase-0 item 6 and its exit criteria; the stop-gate is stated explicitly |

**R8 comparison.** The reviewer's one-phase alternative and this plan's Phase 1 now reach the same
user-visible outcome — a tracker ticket on the board, worked by an agent, moving in the tracker —
so the phase order was not re-cut, but **the contents of Phase 1 were**: its alternative's step 3 (emit the
status event from the real write sites) replaced this plan's item 7, which is the correction in
finding 1. Its judgement that the Phase-2 splits of `issue.service.ts` and `exit-workflow.ts` are
"debt-paydown, not goal-critical" is **accepted in part**: they stay in Phase 2 because the outbox
in Phase 2 item 1 needs a single enqueue point, but they are marked here as the items to cut first
if the programme is descoped — see §8.

Minor findings integrated silently: `routes/issues.ts` now carries its 0.775; the CLI/MCP
distinction in Phase 2 item 5; the rejected cheaper alternative to the new HTTP client; the kill
switch tagging imported rows; pagination and rate-limit budget; C2 exercised in Phase 1; the
Phase-4 CI-versus-pre-merge-gate question; `.codemetricsrc` confirmed present; the broadcast-count
caveat. One minor is *not* accepted: the reviewer counted 22 files referencing
`transitionIssueStatus`, this run counts 19 production files (tests excluded) — the difference is
immaterial to any decision and the plan states its own number.

## 8. Known shortcomings

- **The whole programme depends on a decision that is not the implementer's to make.** CLAUDE.md
  lists "Local only — no cloud/multi-tenant/OAuth" under *Hard Constraints — never violate*. This
  plan cannot amend it; it can only stop at the gate. **Owner: whoever owns the product's
  positioning.**
- **The tracker's own API semantics are unverified.** This run made no network calls, so the
  Phase-3 conflict rule rests on an unchecked claim about Jira Cloud REST v3 (§6 F-prior), and
  Linear is entirely unexplored — no decision record, doc or line of code in this repo mentions
  it. **Owner: whoever answers D2, who must then re-do Phase 3's risk section against the real
  API.**
- **"The board is a projection of the tracker" is not achievable for the whole entity.** Workflow
  nodes, ticket groups (`coupled_with`, decision 015), artifacts, time entries, drives and
  showdowns have no tracker counterpart. The goal as stated is therefore only ever true of a
  *subset* of the issue row, and this plan declares that subset in Phase 0 rather than pretending
  otherwise. **Owner: a team decision on what "source of truth" is allowed to mean here.**
- **The credential fix in Phase 0 item 2(b) may not be implementable as written.** Whether the
  board's agent-spawn path can scrub a specific variable from the inherited environment on every
  provider (Claude, Codex, Copilot, Pi) was not verified in this run. If it cannot, the OS
  keychain is the only remaining option and Phase 0 grows. **Owner: implementer, at Phase 0.**
- **The Phase-2 broadcast-site counts are second-hand.** They come from the seam agents' greps and
  were not re-counted here, so Phase 2's two L items are sized on numbers this plan does not
  itself stand behind. **Owner: whoever writes the Phase-2 tickets — re-count first.**
- **A single reviewer saw this plan once.** The re-cut of Phase 1 that finding 1 forced is new
  design, and this run did not put the new design in front of a second round. On the evidence of
  this repo's own prior plan — whose round 2 found seven further majors in exactly such a re-cut —
  a second round before implementation would be worth its cost.

## 9. Open decisions for the team

- **D1 — core feature or plugin?** The repo has a working plugin mechanism (manifest, per-project
  `plugin_enabled_<slug>_<projectId>`, own views and scripts, `services/plugin.service.ts`).
  Shipping the tracker integration as a plugin keeps a credential and a network dependency out of
  core; shipping it in core is what "source of truth" arguably demands, since the issue model
  itself changes. The data cannot decide this, and it changes the size of nearly every Phase-1
  item.
- **D2 — Jira or Linear?** The plan deliberately builds one client, not an interface. Nothing in
  this repo mentions Linear at all; the prior plan and all recorded thinking assume Jira. Choosing
  Linear means the API-semantics risks in Phase 3 are entirely unexplored.
- **D3 — the conflict rule.** Which side wins per field, and what the user sees when the loser was
  a human edit.
- **D4 — who owns the tracker project's configuration** (workflow states, required fields)? The
  status map depends on it, and it is usually not the developer's to change.
- **D5 — does an unbound project stay fully local forever?** This plan assumes yes. If not,
  CLAUDE.md:14 needs a stronger amendment than Phase 0 proposes.

## 10. How to re-measure

```
CM=<code-metrics>/.venv/Scripts/code-metrics.exe
$CM analyze <repo> -o out --days 180              # snapshot; read provenance.resolution_coverage
$CM baseline out/analysis.json                    # pin at each phase start
$CM compare out/analysis.json --history-ref <phase-start-sha>
$CM query out/analysis.json --class refactor_first --top 40   # issue.service.ts leaving the class
$CM candidates out/analysis.json                  # introduce_event gone from exit-workflow.ts
$CM refactor out/analysis.json --boundaries       # server<->shared co-change <= 0.49
$CM query out/analysis.json --module-crime        # hidden dependency mcp-server<->server
$CM query out/analysis.json --tangle              # mcp-server containment (23% today)
$CM graph out/analysis.json --dependents-of packages/shared/src/schema/issues.ts   # stays 13
$CM scorecard out/analysis.json                   # advisory only; all 26 targets are defaulted
$CM analyze <repo> --fail-on-violations           # the Phase-4 CI gate
```
