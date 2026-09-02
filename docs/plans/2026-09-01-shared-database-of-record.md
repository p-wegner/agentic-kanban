# One shared database of record — modernization plan for agentic-kanban

Goal, in the requester's words: *"The board's data moves off each developer's local SQLite file
and into one shared Postgres, so several developers and their agents work against a single board
instead of one board each. Today every instance opens its own `kanban.db`; we want one database
of record, with whatever ownership, concurrency and identity that forces."*

Produced with the `modernization-plan` skill. This document is the *plan*; nothing in it has been
implemented.

## Provenance

- **Repo / commit**: `agentic-kanban` at `f39e4ca7dc` (2026-09-01 12:14 +0200). Working tree was
  **dirty at measurement**: `baseline`, `docs/plans/2026-09-01-external-tracker-source-of-truth.md`
  and `docs/plans/2026-09-01-pr-ci-delivery.md` untracked. Metrics snapshot: `code-metrics analyze`
  at 2026-09-01 10:36 UTC, **180-day** window, **3,128 files**, 7,073 commits → 3,407 change sets.
  Production 236,491 SLOC / test 187,183 SLOC (44 % test share). **HEAD moved during the
  writing of this plan** — another session merged in this checkout and `HEAD` was `2ebe615fb3` when
  the plan was finished. Nothing was re-measured against it; every number here is `f39e4ca7dc`, and
  §10 says how to re-run.
- **Graph reach** (`provenance.resolution_coverage`): **TypeScript imports 8,701 / 8,707 =
  0.9993** — graph numbers for TS are usable **as stated**. Python: `seen: 0` on both channels
  with 7 `.py` files present — that channel contributed **nothing**; it is *unmeasured*, not zero.
  Channel `calls: absent:no_call_resolution_channel` — **every "nothing calls X" in this plan is a
  grep, not a metric.** Other channels unmeasured on this run: runtime shape (no report), mutation
  (no report), code age (not requested), surface (no annotated routes — reported unmeasured, not
  zero), activation state (dead-code findings stay UNKNOWN), defect register (none configured).
- **Which command produced a dependents count matters.** Every dependents figure below comes from
  `graph --stats`, which **erases TypeScript type-only edges**. `db/index.ts` reads **251** there;
  a grep of the same target finds 444 server files importing `db/index.js`, of which 420 import
  only `type Database`. Both numbers are true of different questions. No `analyze`-derived
  coupling number is compared against a `graph` one anywhere in this plan.
- **Prior plan for this goal**: [`docs/plans/2026-08-26-team-capable-modernization-plan.md`](2026-08-26-team-capable-modernization-plan.md)
  (2026-08-26, rev 3). It targets the **same motivation** — "N developers … instead of one board
  each" — by the **opposite mechanism**: each developer keeps a private `kanban.db` and the shared
  source of truth becomes Jira (its C1/C4/C6). Fate: **CONTRADICT**. §9 carries the choice as an
  open decision for the team; §7 records that the adversarial reviewer was asked to review the
  contradiction. Two further plans from the same day (`…-external-tracker-source-of-truth.md`,
  `…-pr-ci-delivery.md`) address adjacent goals and are cited only where they bear on this one.
- **Goal framing**: §1 · **Seams**: 4, fanned out to **2** read-only subagents (S1 alone; S2+S3+S4
  together — they share the same services and registry files). Concurrency **actually run at: 2**;
  `fleet gate --count 2` offered 2, re-checked after spawning: 2.6 GB usable and swapping at
  306 faults/s, so no third agent was released. Both reports are marked **`prior-plan-informed`**:
  both found and cited `docs/plans/` unprompted, both were required to re-derive or label
  `inherited`. Their agreement with each other is *not* three-source corroboration.
- **Refuted / weakened facts**: 3 of 15 (§6) — one of them the plan author's own exclusivity
  claim, caught by the mandatory self-grep; another is **contradicted by the code's own comment**
  (the claim that every workspace-create path runs in the board's own server process). Two further
  rows (F14, F15) record corrections the adversarial review forced, F14 having invalidated the
  first draft's Phase 1.
- **Adversarial review**: see §7.
- **Cost**: see §11.
- **NOT measured / not trustworthy here**: class metrics (`God classes` reports
  `not applicable` — 0.5 % of production SLOC sits in behaviour-holding classes; **UNMEASURED, not
  healthy**); `--rework` (agent commits use `fix:` for follow-ups — a convention artifact; used
  nowhere in this plan, including exit criteria); **all 26 scorecard targets are defaulted**
  (calibrated on another codebase — advisory only, and no exit criterion rests on one); runtime
  behaviour; Postgres operational cost; libsql-server vs. Turso hosting economics.

---

## 1. Goal as capability delta

| # | Capability (target state) | Quality demanded | Seam | Today |
|---|---|---|---|---|
| C1 | One database of record; N board instances connect to it | replaceable persistence; kernel change must be additive/versioned | **S1** | one `kanban.db` per checkout; 12 handle-open sites in 9 modules |
| C2 | Schema + migrations run once, not per instance, and are dialect-portable | single migration authority | **S1** | `runMigrations()` at server boot **and on every CLI command**, no lock anywhere |
| C3 | No SQLite-only surface leaks past the driver | replaceable persistence | **S1** | 57 `PRAGMA` sites, 151 hand-written SQLite migrations, ~2,150 LOC of libsql/SQLite defect mitigation |
| C4 | Concurrent writes from several instances neither corrupt nor lose work | multi-instance safe; stated conflict rule | **S2** | 17 transactions against 559 write sites in `packages/server/src` |
| C5 | Background loops do not all fire in every instance | leader election or idempotency | **S2** | 22 background services, 17 of them periodic sweeps, each assuming it is alone |
| C6 | Machine-specific state never lands in shared rows | multi-instance safe; scoped settings | **S3** | 14 tables carry path / pid / port / profile columns |
| C7 | Every write carries an actor; per-user settings separated | identity-aware | **S3** | **zero** identity columns in 48 schema files; no auth middleware |
| C8 | A change made by instance A becomes visible in instance B | observable across processes | **S4** | in-process WS fan-out; every out-of-process ingress assumes loopback (12+ sites, F13) |
| C9 | Connection string + credentials have a home outside the shared data | secret-safe | S1/S3 | no secret notion in the settings registry |
| C10 | MCP server, CLI and workers address the shared DB, not a file path | externally contracted | **S1** | MCP opens its own handle; the worker fleet is already API-mediated |

No capability row is seamless; no seam is unjustified by a row.

## 2. What the metrics say about the ground we build on

- **The kernel this goal must change is the single most depended-on file in the repo.**
  `packages/shared/src/schema/index.ts` — **581 dependents** (`graph --stats`), ahead of
  `server/src/__tests__/helpers/test-db.ts` (352) and `server/src/db/index.ts` (251). C1/C4/C6/C7
  all add columns here. Rule for the whole plan: **additive migrations only, never an in-place
  rewrite of the schema barrel.**
- **The engine independently names the boundary this work lands on.**
  `refactor --boundaries`: `server → shared w=1465 ×1465, co-change 0.49 over 9 file pairs →
  **introduce_facade**` — the heaviest and leakiest module edge in the repo. The schema +
  `db-path` + `db-client` trio *is* the bulk of that edge. `mcp-server → shared w=130 →
  introduce_facade` is the same move for the second process. The plan adopts these rather than
  inventing a seam.
- **`shared` is already a pass-through, so putting a driver boundary in it is consistent with its
  measured role**, not against it: `--tangle` containment **35 %** (only `mcp-server`, 23 %, is
  worse); `--module-crime` internal co-change **12 %**.
- **The work will be multi-module by the repo's own history.** `--tangle`: 48.6 % of 3,014 logical
  changes already touch 2+ modules; `client ↔ server` 1,052 shared change sets (35 %),
  `server ↔ shared` 653 (22 %). Change entropy 0.84.
- **Three hidden contracts** (`--module-crime`, co-change with no static import edge):
  `client ↔ server` (1,052 sets, Jaccard 0.371), `mcp-server ↔ server` (205, 0.098),
  `client ↔ mcp-server` (123, 0.064). The second is exactly the pair Phase 2 makes explicit when
  the MCP create path stops writing `workspaces` on its own.
- **Hot-on-seam files, with their prescribed moves.** `refactor_first` holds 338 files; on this
  goal's seams: `SettingsPanel.tsx` **0.906** (#1, churn 435), `exit-workflow.ts` **0.871**
  (`introduce_event`, priority 0.582, 8 cross-module calls), `project.service.ts` **0.854**
  (`split_responsibility` 0.711 → seams *projectid / **repopath** / setprojectarchived* — the
  middle group is literally the machine-path surface C6 must move),
  `server-start.ts` **0.838** (churn 399 — the composition root Phase 1 edits),
  `monitor-auto-start.ts` **0.769**, `issue.service.ts` / `routes/issues.ts` **0.776**,
  `monitor-cycle.ts` **0.764** (`split_responsibility` → 4 seams),
  `startup-tasks.ts` **0.763** (owns `runMigrations` and the pre-migration backup).
- **The schema itself is in good shape for a port.** `data_model` (from
  `packages/shared/src/schema/`, 47 Drizzle files): 57 tables, 90 indexes, **FK coverage 1.00**
  (66 of 66 constrainable refs enforced), 0 polymorphic refs, 0 duplicate or prefix-redundant
  indexes, 0 unserved predicates. One god table — `workspaces`, 38 columns — and **one** ref with
  no index behind it: `workspace_issue_members.workspace_id → workspaces`
  (`ref_index_coverage 0.9848`).
- **14 tables carry machine-local columns** (`data_model.tables`, by column name):
  `workspaces` (`working_dir`, `claude_profile`, `pending_plan_path`), `repos` (`path`,
  `worktree_path`), `projects` (`repo_path`, `remote_url`, `symlink_dirs`), `sessions` (`pid`),
  `plugins` (`local_path`, `source_url`), `plugin_view_processes` (`pid`, `port`),
  `workspace_provisioning` (`worktree_path`, `server_pid`), `workspace_merge_run` (`pid`),
  `project_script_shortcuts` (`working_dir`), `diff_comments` (`file_path`),
  `flaky_tests` (`test_file_path`), `workspace_symlink_run` (`dirs`), plus the derived caches.
  This is the C6 worklist, derived mechanically rather than by reading.
- **Scorecard** (composite 90.0/100, **26 of 26 targets defaulted — advisory**): the reds that
  matter here are structural, not on this seam — 435 files with complex functions, centre of
  gravity 0.449. **No exit criterion in this plan rests on a defaulted target.**

## 3. Seams and their components

### S1 — Persistence, dialect, migrations

| Component | Files | Role | What changes for the goal | Class | Size |
|---|---|---|---|---|---|
| Schema barrel + tables | `shared/src/schema/**` (47 `sqliteTable` files) | the data model | `pgTable`; 27 `integer({mode:"boolean"})` → `boolean`; **text** ISO timestamps, **text** JSON and text-UUID PKs all survive unchanged (0 `mode:'timestamp'`, 0 autoincrement) | **kernel** (581 dependents) | L |
| Migration corpus | `shared/drizzle/**` (151 `.sql`, dialect `sqlite`) | schema history | regenerate a PG baseline; 3 migrations use the SQLite FK-off 12-step table rebuild and have no PG analogue | cold-on-seam | L |
| In-house migrator | `db/manual-migrate.ts` (374 LOC), `startup-tasks.ts:171,201`, `cli/shared.ts:173`, `scripts/db-migrate.ts`, `scripts/db-repair.ts:258` | applies migrations | **must gain a lock**; must stop running per CLI command | hot-on-seam (`startup-tasks.ts` 0.763) | L |
| Handle ownership | `db/index.ts` (2 clients), `db/data-dir.ts`, `db/pragmas.ts`, `db/retry.ts` | connection + busy retry | pool; drop pragmas; retry predicate `SQLITE_BUSY` → PG `40001`/`40P01` | **kernel** (251 dependents) | M |
| Location resolver + client factory | `shared/lib/db-path.ts`, `shared/lib/db-client.ts` | DSN precedence, 7-pragma bootstrap | becomes a DSN resolver; **already accepts a remote endpoint** | cold-on-seam | M |
| Second process's handle | `mcp-server/src/db.ts`, `tools/deps.ts` (+38–41 tools using `deps.db`) | MCP's own connection | re-point, or route through the board API as 25 tools already do | cold-on-seam (`mcp-server` containment 23 %) | M |
| Repository layer | `server/src/repositories/**` (134 files; 132 take a `Database` parameter) | queries | mechanical; ~11 `json_extract`/`group_concat` sites need PG spellings | cold-on-seam | M |
| SQLite defect mitigation | `db/fk-violations.ts`, `db/utf8-repair.ts`, `shared/lib/fk-actions-repair.ts`, `fk-assert.ts` | guards hazards PG does not have | **mostly deletable** — the cheapest win in the plan | cold-on-seam | S |
| Backup / restore | `db/backup.ts`, `db-restore.ts`, `backup-scheduler.ts`, `scripts/db-repair.ts` (~1,100 LOC) | `VACUUM INTO` + `PRAGMA integrity_check` | replaced by a PG backup story | cold-on-seam | L |
| Strays | `packages/server/query62.cjs`, `scripts/rework-loop-analysis.mjs:182` | ad-hoc readers bypassing the resolver | delete or re-point | cold-on-seam | S |

### S2 — Concurrency, ownership, background loops

| Component | Files | Role | What changes | Class | Size |
|---|---|---|---|---|---|
| Auto-start claim | `services/auto-start-claim.ts:31-35`, `services/create-job.service.ts:53` | the in-memory guard against double-provisioning | a `workspace_claims` row with a unique key and a lease | cold-on-seam | S |
| The other create doors | `mcp-server/src/tools/start-workspace.ts:79,130`, `cli/commands/workspace.ts:171`, `repositories/{workspace-crud,followup-workspace,workflow-fork-children}.repository.ts` | 7 `insert(workspaces)` sites in 3 processes | all route through the claim | contract (`mcp-server ↔ server` hidden pair) | M |
| Monitor cycle + auto-start | `startup/monitor-setup.ts:189`, `monitor-cycle.ts`, `monitor-auto-start.ts:630-715` | starts, merges, relaunches | leader-only; WIP read→launch inside one transaction | hot-on-seam (0.764 / 0.769, both `split_responsibility`) | L |
| Background service registry | `startup/background-services.ts:73` (`BACKGROUND_SERVICES`, 22 entries, 17 periodic sweeps), consumed at `server-start.ts:138` | crash recovery + cron | each entry classified leader-only / machine-scoped / already-safe | hot-on-seam (`server-start.ts` 0.838) | L |
| Pid-scoped ownership | `repositories/workspace-provisioning.repository.ts:65-70`, called from `startup-tasks.ts:959` | decides which in-flight creates are abandoned | `owner_instance`, not `process.pid` | cold-on-seam | M |
| Transaction coverage | `db/index.ts:71-77` (`withTransaction`) + 559 write sites | atomicity | wrap the named read-modify-write paths | **kernel** | L |
| Machine-scoped singletons | `services/port-allocator.ts:43`, `worker-slot-reservation.service.ts:42`, `plugin/loop-advance-lock.ts` | in-memory reservations | DB rows, or explicitly declared machine-local | cold-on-seam | M |
| Merge path | `services/workspace-merge.service.ts` (0.844, churn 121), `shared/lib/repo-lock.ts` | landing work | already has a cross-process lockfile — but it is per-repo on local disk | hot-on-seam | M |

### S3 — Machine state, settings, identity

| Component | Files | Role | What changes | Class | Size |
|---|---|---|---|---|---|
| Path columns | the 14 tables in §2; writers in `repositories/{project,repo,workspace-crud,session-lifecycle,plugins,project-scripts}.repository.ts` | local paths in shared rows | machine scope or translation | cold-on-seam | M |
| Path translation layer (partial, exists) | `repositories/project-relocate.repository.ts`, `services/project-relocate.service.ts` | enumerates path-bearing columns "in exactly one place" | extend to the columns it misses | cold-on-seam | S |
| `project.service.ts` | 0.854, `split_responsibility` → *projectid / **repopath** / setprojectarchived* | project registration by local path | the engine's own **repopath** group is the C6 cut | **hot-on-seam** | L |
| Settings | `shared/schema/preferences.ts` (`key` PK, `value`, `updated_at` — no scope), `shared/lib/settings-registry.ts:29-34` (`SettingDef` = `{type, default}`), `repositories/preferences.repository.ts`, `client/components/SettingsPanel.tsx` | flat global KV | a `scope` axis; ~20 machine-bound keys leave the shared table | **hot-on-seam** (SettingsPanel 0.906 #1; preferences.repository = 103 dependents, **kernel**) | M |
| Identity | *(none)* + `shared/schema/{issue-comments,workers,sessions}.ts`, `routes/issues.ts:684`, `middleware/` | absent | request-scoped actor; `actor_id` on write tables; API auth | **absent → new** | L |

### S4 — Cross-instance events

| Component | Files | Role | What changes | Class | Size |
|---|---|---|---|---|---|
| Event bus | `services/board-events.ts:75` (`createBoardEvents`, one call site) `:273` (`BoardEventSink` port), wired at `startup/core-services-wiring.ts:36` | in-process WS fan-out | a remote-capable implementation swaps at **one line** | cold-on-seam | M |
| Out-of-process ingress | `routes/index.ts:133-146` (`POST /api/internal/board-notify`), `mcp-server/src/notify.ts:10,25` (`board-notify` **and** `workflow-advanced`), `mcp-server/src/board-call.ts:17` (25 tools), `shared/lib/board-server-url.ts:1` (`LOOPBACK_HOST = "127.0.0.1"`) plus **12+ further hardcoded loopback sites** (F13) | other processes reaching the board | not one constant — a spread assumption; this is why P5.4 stays optional | cold-on-seam | **M, not S** |
| Client fallback | `client/src/lib/useBoardEvents.ts:17` (30 s poll) | catch-up | **this plan deliberately keeps it** as the cross-instance path until Phase 5 | cold-on-seam | — |

## 4. Do-not-touch (hot, off-seam)

No capability row reaches these. They are listed so nobody "fixes them while there".

| File | Risk | Why it is off this seam |
|---|---|---|
| `client/src/components/Layout.tsx` | 0.884 | UI shell |
| `client/src/components/WorkspacePanel.tsx` | 0.869 | UI |
| `client/src/components/BoardToolbar.tsx` | 0.831 | UI |
| `client/src/components/IssueDetailPanel.tsx` | 0.800 | UI |
| `client/src/routes/BoardPage.tsx` | rank 0.800 (`split_responsibility` → 3 seams) | UI composition |
| `client/src/components/ButlerView.tsx` | 0.776 (`split_responsibility` → 4 seams) | agent chat UI |
| `client/src/components/IssueCard.tsx` | 0.769 | UI |
| `client/src/components/{CreateIssuePanel,CreateIssueForm}.tsx` | 0.762 / 0.758 | UI |
| `server/src/services/plugin-loop.service.ts` | 0.736 (max CC 44) | plugin loop; only its `loop-advance-lock` is on-seam |
| `server/src/startup/exit-workflow.ts` | **0.871**, `introduce_event` 0.582 | on a seam (S4) but **deliberately deferred**: its prescribed move serves cross-instance push events, which this plan does not build. Applying it now buys the goal nothing. |

## 5. Phases

Sequencing rationale, in one paragraph, because it is the plan's main judgment: the measured
blockers to "several developers work against a single board" are 12 handle-open sites, **zero
locking of any kind**, pid-based ownership, an in-process-only claim map and **zero identity** —
all *dialect-independent application defects that Postgres does not fix*. Meanwhile
`KANBAN_DB_URL`/`DB_URL` already accepts a remote libsql endpoint, wins over every other
DB-location rule, and is tested (§6, F1). So Phase 1 reaches **one shared database of record** at
near-zero dialect cost, the concurrency and identity work happens against it in Phases 2–3, and
the **Postgres dialect cutover is Phase 4** — the same schema design, re-emitted onto the target.
The team may prefer to run Postgres from day one; that is §9's first open decision, and it changes
which endpoint Phase 1 points at, **not the phase order**.

### Phase 0 — Decide, pin, protect *(no behaviour change)*

Goal: the decisions Phase 1 cannot proceed without, plus the measurement and the safety net.

- **P0.1** Decision record `018-shared-database-of-record.md`. It must reverse, **by name, three
  recorded statements**, not one: `CLAUDE.md:14` ("**Local only** — no cloud/multi-tenant/OAuth");
  `docs/prd.md:222-223` ("Multi-tenant / organizations / team collaboration", "Cloud deployment /
  PostgreSQL / ElectricSQL") under **Non-Goals (Explicitly Skipped)**; and
  `docs/prd/01-features-catalog.md:468-469`. Scope the reversal narrowly: **one shared database of
  record inside one trusted network; still no multi-tenancy, no public hosting, no OAuth.** State
  where the DSN and its credentials live (env var / OS keychain — **never a board row**, following
  the worker fleet's existing `token_hash` precedent). **It must also settle the contradiction with
  `docs/plans/2026-08-26-team-capable-modernization-plan.md` in one direction, and mark the losing
  plan superseded in that plan's own header** — see §9.2. (S)
- **P0.2** `code-metrics baseline pin --label shared-db-phase0`, and **pin numerically, in the
  decision record, every phase-start value this plan's criteria compare against**: E0.2's coverage
  figure, E1.7's per-file CC, E3.3's route inventory, E4.1's two counts, and E1.1's byte-level
  shared-database baseline. The handle-opener rule is a **repo-local shrink-only ratchet test**
  (the `packages/shared/__tests__/wire-dto-single-declaration.test.ts` shape): a DB handle may be
  created only in `packages/server/src/db/**`, `packages/shared/src/lib/db-client.ts`,
  `packages/mcp-server/src/db.ts`, and the type `LibSQLDatabase` may be named only there. *It is
  **not** a `.codemetricsrc [architecture]` rule: that section accepts only `layers` and
  `forbidden` module→module edges (`config.py:266-270,468-470`), so a file allowlist and a
  symbol rule are not expressible — round 2 caught the first draft assuming otherwise, which would
  have left E0.1 and E5.3 unrunnable.* (S)
- **P0.3** Characterisation tests on the seven functions Phase 1 edits:
  `startup-tasks.runMigrations`, `manual-migrate.applyMigrations`, `startup-tasks.runStartupAuditTasks`,
  `monitor-setup`'s cycle guard, the `BACKGROUND_SERVICES` registration loop,
  `workspace-provisioning.listAbandonedProvisioning`, `auto-start-claim.claimIssueForAutoStart`.
  Record a trace **with the role flag unset** and replay it after every Phase 1 item, so "flag off
  = today" has a check rather than a promise. (M)
- **P0.4** Delete `packages/server/query62.cjs` (a committed one-off that opens `./kanban.db`
  CWD-relative through `better-sqlite3`, bypassing every resolver) and re-point
  `scripts/rework-loop-analysis.mjs:182` at the resolver. (S)
- **P0.5** Instrument: every `applyMigrations` entry logs pid + hostname + pending tags. (S)

**Exit criteria**

| # | Criterion | Phase-start value | What turns it red |
|---|---|---|---|
| E0.1 | The P0.2 handle-opener ratchet test is green with an allowlist of exactly the three permitted modules | **2 violators** (`packages/server/query62.cjs`, `scripts/rework-loop-analysis.mjs:182`) | any file outside the three allowed modules calling `createClient`/`DatabaseSync`; P0.4 not done; the allowlist grown instead of the violator fixed |
| E0.2 | merged line coverage of the seven P0.3 files ≥ 90 % | **pinned numerically in P0.2's decision record before any Phase-1 work** (repo headline is 72 % merged; the first draft said "measured at pin", which is the **A2** the review caught) | a function added to the set with no test; coverage falling |
| E0.3 | decision record 018 exists and quotes all three reversed statements verbatim | **0 of 3** quoted | quoting only `CLAUDE.md:14` — the narrowing the skeleton review caught |
| E0.4 | `docs/plans/` contains exactly **one** non-superseded plan for the "several developers, one board" motivation | **2** (this plan and the 2026-08-26 team-capable plan, neither marked) | the losing plan left unmarked, so the next reader picks by reading order |

**Risks**: P0.1 is a product decision, not an engineering one — if the team declines it, the plan
stops here and that is the correct outcome. **Do-not-build in this phase**: any port, any column.

### Phase 1 — Two boards, one database, one leader *(flagged, additive, reversible)* — **FIRST USER-VISIBLE OUTCOME**

Goal: two developers on two machines see and edit **one** backlog. Exactly one instance (the
leader) runs agents, worktrees, merges, loops and every convergence pass; the others are
full-fidelity **readers and backlog editors** — that second half is a requirement, not a courtesy,
and two of the three review rounds broke it.

> *Re-cut three times (§7), each time because the previous mechanism was disproved by reading the
> code rather than by argument. Round 1: gating the `BACKGROUND_SERVICES` loop misses a second
> registry. Round 2: gating call sites misses eight entry points, one of which stops the leader's
> agent sessions. Round 3: **enumerate-and-omit is the wrong shape** — it missed a third ingress
> (the fleet listener), and three of its omissions would have broken the follower as a reader.
> The mechanism is now **deny-by-default**: a follower mounts the whole application and one
> middleware refuses everything not on a short allowlist. That is provable by reading one file;
> "did we find every writer?" has now failed three times.*

- **P1.1** `resolveBoardRole()` in `packages/shared/src/lib/` — **not** in the server, because the
  role must hold in three processes (server, MCP, CLI). Default: `leader` when the DSN is local,
  **`follower` when `KANBAN_DB_URL` points at a non-local endpoint and the role is unset**, so the
  dangerous state needs an explicit opt-in rather than a remembered env var. Registered in
  `lib/env-registry.ts` **and** `docs/env-vars.md` (the parity test pins the pair). (S)
- **P1.2** Extract `startup/leader-runtime.ts`: everything `startServer()` does that converges or
  schedules moves there **as a move, not a rewrite**, and `server-start.ts` gains **one**
  `if (role === "leader") await startLeaderRuntime(ctx);`. What moves, and why each one matters on
  a shared database:
  - `runBootSequence`'s convergence half (`server-start.ts:52`). `runCriticalStartupTasks`
    (`startup-tasks.ts:863-868`) is four calls: `killOrphanedServers`, `runMigrations`,
    `alignLiveDbForeignKeys`, `cleanupStaleSessions`. `cleanupStaleSessions`
    (`startup-tasks.ts:348-380`) selects **every** `sessions` row with `status="running"` and no
    worker — **no instance scope** — probes `isPidAlive` against *this machine's* process table and
    writes `status:"stopped"` plus workspace `idle`: ungated, **a follower boot stops every running
    agent session of the leader**. Then `recoverRemoteSessionsAtBoot`, `reapOrphanServiceStacksOnce`,
    `runSessionRestore`.
  - `runGatedDeferredStartupTasks` (`:123`) and its `.then(() => runStartupAuditTasks())` tail
    (`:131`) — 4 + **11** reconcilers converging shared rows from this machine's checkout.
  - The `BACKGROUND_SERVICES` loop (`:149`; 22 entries, 17 periodic sweeps).
  - The whole `if (fleetPort !== null)` block (`:161-198`) — **both** `startFleetListener` (`:163`),
    which binds an off-loopback surface accepting `POST /api/workers/register`, `/heartbeat`,
    `/incoming/land`, `/incoming/discard` (`routes/workers.ts:173,194,286,359`), and
    `ensureGitHttpServer` (`:190`). *Round 3 found the listener; the previous draft's omission list
    was line-anchored and gated only the second half of one `if`.*
  - `startMonitorRuntime()` — the **runtime half** of `createMonitorSetup`: the `boardEvents`
    invalidation listener (`monitor-setup.ts:692`), the 30 s `syncMonitorState` timer and the 5 min
    `runStandaloneResourceSweep` + `healWorkspaceSummaryProjection(db)` pair (`:701-705`), the last
    of which **writes** `workspaces.summary_*` / `repos.summary_*` from this checkout. (M)
- **P1.3** Split `runMigrations()` — the item Phase 1 cannot proceed without, because
  **every shared-row write attributed to "boot" is inside `runMigrations()` itself**:
  `ensureBuiltinTags/Skills/Workflows` (`startup-tasks.ts:208-216`, which updates
  `issues.currentNodeId` and `workspaces.currentNodeId` via `db/builtin-workflows.ts:844-859`),
  `deduplicateProjects()` (`:219`), `unregisterLeakedTempProjects()` (`:229`), the hook-wiring sweep
  with `repair: true` (`:253-255`, which writes **to disk in every registered project's repo** —
  on a follower, against the leader's `repoPath` values), the `preferences.auto_monitor = "false"`
  upsert (`:261-263`, so a follower boot silently disables the leader's monitor) and
  `migrateGlobalDefaultModelToProviderScope` (`:270`). So "run the migration verify but skip the
  seeding" is not a separation the code offers today: extract `verifySchemaVersion()` (a pure read,
  which every process runs) from `applyMigrationsAndSeed()` (leader only, behind P1.4's lease).
  `alignLiveDbForeignKeys` — which **rebuilds drifted tables** (`fk-alignment.ts:42`) — moves behind
  the same lease **for the leader too**. (M)
- **P1.4** Single-flight migrations, **including cold start**. `applyMigrationsAndSeed` takes a
  lease with a **blocking wait and a timeout**, not a skip: a guarded `UPDATE … WHERE` on the
  affected row count (the CAS shape already proven at `shared/src/lib/workspace-status.ts:184-201`;
  it reads libsql's `rowsAffected` and needs a one-line adapter for drizzle-pg's `rowCount` in
  Phase 4) tells the loser it lost, and the loser **waits and re-reads the schema version** — if it
  proceeds it serves against a half-migrated database. The lease table is a
  `CREATE TABLE IF NOT EXISTS` **outside** the migration corpus, because on an empty shared database
  the corpus is what races. `cliAction` stops migrating. (M)
- **P1.5** **Deny-by-default at the router, on the whole application.** A follower mounts every
  route the leader does — this is what keeps it a full-fidelity *reader* — plus one middleware that
  409s every non-GET request outside a short allowlist (issue CRUD, comments, sort order, tags),
  every `/ws/workers/**` and `/api/workers/**`, and `POST /api/internal/monitor-run` /
  `resource-sweep`. It also 409s the three request paths that read a pid from a shared table and act
  on *this* machine's processes: `workspace-cleanup.service.ts:61-71` (`killProcessTree(s.pid)`),
  `remote-session-liveness.ts:133` (a user-visible `alive`/`dead` verdict from `checkPid`), and
  `worktree-claim.ts` (probes `server_pid` before removing a worktree). Two consequences the plan
  states rather than hides: a follower **calls `markStartupComplete()` immediately** — it is
  `server-start.ts:126`'s only production caller, inside the deferred phase's `.finally`, and
  `readiness.ts:60-83` holds every non-GET request for `READINESS_GATE_TIMEOUT_MS = 120_000`
  otherwise, which would have made every follower edit take two minutes; and
  `registerMonitorRoutes` still runs on a follower, backed by an inert state, because
  `GET /api/internal/monitor-status` (`routes/internal-monitor.ts:53`) is polled by
  `client/src/hooks/useBoardPreferences.ts:119,150` on every board load and every 30 s in every tab.
  (M)
- **P1.6** The follower's **MCP server** refuses every non-`board-call` tool. It holds its own
  handle (`mcp-server/src/db.ts:42`) and writes directly — `tools/start-workspace.ts:130` inserts a
  `workspaces` row and creates a worktree in-process (§6 F5), `tools/close-workspace.ts:45-57`
  probes `server_pid` from a third pid namespace and can delete a live checkout. Because an MCP
  process is launched from an editor config that may carry no env, P1.1's remote-DSN default is what
  actually protects this path. (M)
- **P1.7** Optimistic concurrency on the one table the first outcome exercises: an issue update
  carries the row's `updated_at` and uses the same guarded CAS; a losing write returns 409. The
  column exists (`packages/shared/src/schema/issues.ts:17`), so **no migration** — but it is a
  `$defaultFn`, i.e. an *application-side* default that raw SQL bypasses
  (`scripts/seed-example-session.ts:42`), and **four writers never bump it**
  (`auto-start-skip.repository.ts:51,72`, `start-scoring.repository.ts:183`,
  `workspace-crud.repository.ts:95`, `project-registration.repository.ts:36`), while
  `issue-service.repository.ts:148` is an untyped `updateIssueById(id, updates)` passthrough. P1.7
  makes every `issues` writer bump it and adds a ratchet naming them. (M)
- **P1.8** Follower freshness, stated honestly: its WebSocket connects to *its own* server, which
  never carries the leader's events, so the only cross-instance path is the 30-second poll in
  `client/src/lib/useBoardEvents.ts:10-17` — and that poll is **visibility-gated**, so a
  backgrounded tab is stale indefinitely. In follower mode it runs unconditionally. A mitigation;
  the fix is P5.4 / §9.6. (S)
- **P1.9** Runbook + a `board doctor` check: which endpoint, who is leader, what a follower refuses,
  the freshness bound (≤ 30 s, foreground *and* background), and **what the kill switch costs** —
  reverting to local files strands every row written to the shared database since cutover. (S)
- **Deliberately NOT in Phase 1**: any migration, any `owner_instance` column, cross-instance push
  events, identity, leader failover, and the SQLite-shaped operations a shared *libsql* endpoint
  already strains (shutdown's `PRAGMA wal_checkpoint(TRUNCATE)` + `createBackup`,
  `db/index.ts:10,30,45`'s import-time `ensureDataDir()`/`applyPragmas()`) — §3 S1 items carried to
  Phase 4, and E1.1 is what reveals whether they can wait.

**Exit criteria**

| # | Criterion | Phase-start value | What turns it red |
|---|---|---|---|
| E1.1 | **Byte-level**: with a leader idle-but-live, ten consecutive follower boots (server **and** its MCP server, `KANBAN_FLEET_PORT` set) leave the shared database's full row set **identical** to the P0.2 baseline dump | no such test; today one follower boot stops the leader's sessions, idles its workspaces, rewrites `preferences` and repairs hooks on disk in the leader's repos | any row differing. *A hand-picked row set would not have caught `preferences.auto_monitor`; that is why this is a whole-database diff* |
| E1.2 | **A follower's board page loads with zero 404s and zero 409s on GET, and its first POST to an allowlisted route completes in under 1 s** | not applicable (no follower exists); a naive omission gate would 404 `/api/internal/monitor-status` and hold the first POST for 120 s | mounting a reduced router; leaving `markStartupComplete()` to the deferred phase |
| E1.3 | An issue created on B is readable **through A's API** within 35 s, with A and B on **two machines** — or, if the team defers off-loopback binding to Phase 3, on one box with two data dirs, **and the plan says which was run** | no such test | running the one-box variant and reporting it as the two-machine outcome. *The board binds `127.0.0.1` (`server-start.ts:56`) and has no API auth (`cors-origin.ts:4-5`), so the two-machine form needs a decision recorded in P0.1* |
| E1.4 | Two `applyMigrationsAndSeed` started concurrently against one endpoint: exactly one applies, **the other waits and then observes the final schema version** — asserted against a populated database **and cold, against an empty one**; `alignLiveDbForeignKeys` holds the same lease; `verifySchemaVersion()` never seeds | today both apply; there is **no lock of any kind** (§6 F4) | the lease advisory, re-entrant, skip-instead-of-wait, bypassed by `cliAction`, unable to bootstrap on an empty database, or the split leaving a seed call on the read path |
| E1.5 | **No follower writes a pid to a column** — `workspace_provisioning.server_pid`, `sessions.pid`, `workspace_merge_run.pid`, `plugin_view_processes.pid` — asserted by E1.1's byte diff over those four columns | 4 pid-writing columns, no instance scope; the absolute form ("no pid reaches a column at all") is **E2.4's**, because its replacement is P2.0's `owner_instance` and E1.6 forbids a column here | a follower path writing a pid; the criterion restated in the absolute form Phase 1 cannot reach (that was an **A10** round 3 caught) |
| E1.6 | Schema objects added to the shared database by Phase 1: **exactly 1** — the migration-lease table, outside the corpus — and migrations added: **0** | 151 migrations; 57 tables | any item reaching for a column or a second table. *Do not trade this away to make E1.5 absolute: it is what keeps the kill switch one environment variable* |
| E1.7 | `server-start.ts` gains at most **+2** summed cyclomatic complexity (the single `if`); `leader-runtime.ts` is unconstrained because it is a **move**; `startup-tasks.ts` at most +2 for the `runMigrations` split | pinned per file in P0.2 (`server-start.ts` CC 17, churn 399, risk 0.838; `startup-tasks.ts` CC 16) | threading the role flag into the tasks instead of moving them — the shortcut this criterion exists to forbid. *The previous "+4" budget was infeasible against seven omission points; round 3 replaced a number with a shape* |
| E1.8 | A follower's MCP server refuses every non-`board-call` tool — asserted by invoking `start_workspace` and `close_workspace`, **including from a process started with `KANBAN_BOARD_ROLE` absent but a remote DSN present** | today the MCP process writes `workspaces` rows and removes worktrees directly (§6 F5) | the role defaulting to `leader` when the env var is missing — the state an editor-launched MCP process is in by default |
| E1.9 | Every entry in `BACKGROUND_SERVICES` (22), `STARTUP_AUDIT_TASKS` (11) and `runGatedDeferredStartupTasks` (4) carries an explicit scope tag (`leader` / `machine-safe`), with a shrink-only ratchet on new untagged entries | **37 entries, 0 tagged** | a new reconciler added untagged. *The tags are **not** the Phase-1 mechanism — the move and the middleware are; they exist because P2.0 needs them* |

**Risks**: the biggest is unchanged and now well evidenced — **a follower's inertness cannot be
established by reading**, and each of three rounds found a writer class the previous enumeration
missed. That is precisely why the mechanism ended as deny-by-default plus a byte-level diff rather
than a list. The second risk is the mirror image and cost this plan two rounds to see: three of the
omissions that made a follower safe would have made it useless as a reader (E1.2 is the guard).
**Kill switch**: unset `KANBAN_DB_URL` and every instance reverts to its own local file — rows
written to the shared database since cutover stay there (P1.9 says so). **Do-not-build in this
phase**: leader election, a claims table, any new transport, any column.

### Phase 2 — Make the shared writes safe *(loops on more than one instance)*

Goal: remove the single-writer assumptions, so leadership can move and more than one instance can
act. This is the first phase that changes the schema.

- **P2.0** `owner_instance` on `workspace_provisioning`, `sessions`, `workspace_merge_run`,
  `plugin_view_processes`; every pid-keyed predicate filters on it, and the 11 `STARTUP_AUDIT_TASKS`
  entries tagged in P1.1 act only on rows this instance owns. *(Moved here from Phase 1 by review
  round 1. Round 2 showed the "correct by construction" argument was too broad — pid columns are
  also **read** on request-driven paths — so P1.3 409s those three paths on a follower and the
  columns still wait for Phase 2, which is where they stop being a workaround. Unify
  `isPidAlive`'s fail-toward-alive (`lib/pid.ts:23`) with `worktree-claim.ts`'s fail-toward-dead
  here, and copy `plugin_view_processes`' command-line cross-check (`startup-tasks.ts:469`), the
  only pid table that has one.)* (M)
- **P2.1** `workspace_claims` (issue_id unique, `owner_instance`, `lease_expires_at`). **All seven**
  production `workspaces` writers route through it: `repositories/workspace-crud.repository.ts:87`,
  `repositories/followup-workspace.repository.ts:98`,
  `repositories/workflow-fork-children.repository.ts:61,87,106`,
  `mcp-server/src/tools/start-workspace.ts:130` (a second process, §6 F5), and
  `server/src/scripts/seed-example-session.ts:42` (raw SQL — either routed or named as an explicit
  exclusion in the ratchet, never silently omitted). Add a shrink-only ratchet test naming the
  permitted writers, in the shape the repo already uses in
  `packages/shared/__tests__/wire-dto-single-declaration.test.ts`. (M)
- **P2.2** Partial unique index on `issues.external_key`; delete
  `services/plugin/loop-advance-lock.ts`, whose own header says a unique index is the right fix and
  declines it only because the deployment is single-process. That lock currently **queues** the
  second advance and reports `skippedExisting`; a unique index turns it into a constraint error, so
  P2.2 must ship the replacement behaviour (catch-and-report-skipped is the like-for-like). (S)
- **P2.3** The WIP read→decide→launch window (`startup/monitor-auto-start.ts:630-715`) inside one
  transaction or behind the claim lease. (M)
- **P2.4** `port-allocator` and `worker-slot-reservation` become DB rows — or are explicitly
  declared machine-local with a test that says so. `verify-chain-semaphore` and
  `jvm-build-semaphore` stay machine-local by design; that is a decision to record, not a defect to
  fix. (M)
- **P2.5** Wrap the named read-modify-write paths in `withTransaction`, each with a test that fails
  under simulated interleaving. (L)
- **P2.6** Leader election as a lease row, replacing P1.1's env var. (M)

**Exit criteria**

| # | Criterion | Phase-start value | What turns it red |
|---|---|---|---|
| E2.1 | `workspaces` writers not routed through `workspace_claims`: **0**, enforced by the P2.1 ratchet | **7**, enumerated in §6 F5 | a new direct insert; the MCP door or the seed script left unrouted |
| E2.2 | Every named read-modify-write path has an interleaving test that **fails when its transaction is removed** | 0 such tests exist (17 `withTransaction` sites against 559 write sites) | a path wrapped without a test proving the wrap matters. *Round 1 asked for the first draft's "≥ 32 sites" half to be dropped as an invented target — it was* |
| E2.3 | A 30-minute two-leader soak — both instances running the monitor cycle **and** the boot audit against one endpoint — produces 0 duplicate `workspaces` rows per issue and 0 duplicate `issues.external_key` | today this duplicates; `auto-start-claim.ts`'s own header records it happening in-process | any duplicate |
| E2.4 | Every column that held a pid has an `owner_instance` beside it, and all 11 audit tasks are tagged and scope-filtered | 4 pid columns, 0 `owner_instance`, 11 untagged | a machine-tagged task acting on a row it does not own |

**Risks**: P2.5 is the largest item in the plan and touches the kernel. It comes *after* Phase 1 has
a safety net and a working two-instance e2e, not before. **Do-not-build**: identity, auth, dialect
work.

### Phase 3 — Identity and scoped settings

Goal: the shared board knows who did what, and stops shipping one developer's machine settings to
everyone else.

- **P3.1** Request-scoped actor; `actor_id` on the write-bearing tables (`issues`,
  `issue_comments`, `diff_comments`, `workspaces`, `sessions`, `issue_time_entries`). Attribution,
  not access control. `issue_comments.author` stays as the *role* enum it is. (L)
- **P3.2** API authentication. `lib/cors-origin.ts:4-5` states plainly that the board has **no API
  auth** and that any local process has full authority *by design*; the perimeter is the loopback
  bind (`server-start.ts:154-159`). A shared database turns that into "every developer's every
  process has full authority over everyone's board." The worker fleet's bearer/pairing-token
  pattern (`routes/workers.ts:280-370`, `workers.token_hash`) is the shape to extend. (M)
- **P3.3** `scope: global | project | user | machine` on `SettingDef`
  (`shared/lib/settings-registry.ts:29-34`) and a resolver; the machine-bound keys
  (`projects_base_path`, `agent_command`, `claude_profile`/`codex_profile`, `devcontainer_builders`,
  `max_concurrent_stacks`, and the per-project `dev_command` / `verify_script` / `worker_labels`
  family) leave the shared `preferences` table. (M)
- **P3.4** Extend `project-relocate`'s path enumeration to the columns it misses
  (`plugins.local_path`, `workspaces.pending_plan_path`, `project_script_shortcuts.working_dir`,
  `workspace_provisioning.worktree_path`, `workspaces.service_state`). (S)

**Exit criteria**

| # | Criterion | Phase-start value | What turns it red |
|---|---|---|---|
| E3.1 | The six declared write-bearing tables all carry `actor_id`, and a test asserts a write without an actor is rejected | **0** identity columns across all 48 schema files | a write path that defaults the actor to a constant — the `routes/issues.ts:684` pattern of trusting the body |
| E3.2 | Machine-scoped keys present in the shared `preferences` table: 0 | ~20 (enumerated in P3.3) | a new machine-bound key registered without a scope |
| E3.3 | Write routes reachable without authentication: **0**, asserted by a test that walks the Hono route table and requires every non-GET route to be either behind the auth middleware or on a named public allowlist | **the full write-route inventory, enumerated and pinned in P0.2** (today: all of them; `middleware/` contains no auth file) | a route added outside the middleware; the criterion judged by reading rather than by the route-table walk (**A9**) |
| E3.4 | Path-bearing columns not covered by `project-relocate`'s enumeration: 0 | **at least 5** — the five named in P3.4 are a reviewed floor, not a total; the screen that produced them was a column-name substring match and was not exhaustive | a new path column added without registering it; treating 5 as the finished total |

**Risks**: P3.2 changes the security model of a product whose docs say authentication is
deliberately absent. It needs P0.1's decision record to have said so.

### Phase 4 — Postgres dialect cutover

Goal: the shared database of record *is* Postgres.

- **P4.1** `sqliteTable` → `pgTable` — 57 table declarations across 47 files; 27 boolean columns; regenerate a PG baseline
  migration (the 151 SQLite migrations are history, not a port target — three of them use the
  SQLite FK-off table-rebuild dance that has no PG analogue). (L)
- **P4.2** `db/retry.ts:9-12` predicate → PG SQLSTATEs (`40001`, `40P01`); the P1.2 migration
  lease may become `pg_advisory_lock` — or stay as the portable CAS row, which is the cheaper
  answer. (M)
- **P4.3** Rewrite the ~11 `json_extract` / `group_concat` sites
  (`repositories/workspace-service-state.repository.ts`, `monitor-cycle-health.repository.ts`). (S)
- **P4.4** Delete `db/fk-violations.ts`, `db/utf8-repair.ts`, `shared/lib/fk-actions-repair.ts`,
  `fk-assert.ts`. Note that the UTF-8 *sanitizer* sits on the write path and removing it is a
  behaviour change, not a deletion. (M)
- **P4.5** PG backup / restore replacing `VACUUM INTO` and `PRAGMA integrity_check`; the
  pre-migration backup gate in `startup-tasks.ts:171-197` is re-shaped, not deleted. (M)
- **P4.6** Add the missing index on `workspace_issue_members.workspace_id`. (S)

**Exit criteria**

| # | Criterion | Phase-start value | What turns it red |
|---|---|---|---|
| E4.1 | `sqliteTable` occurrences in `packages/shared/src/schema`: 0; `PRAGMA` occurrences in production TS: 0 | **57 occurrences across 47 files**, and **57** — *round 1 caught the first draft quoting the file count as the occurrence count; re-pin both numerically at P0.2 rather than trusting either* | a table or a pragma left behind |
| E4.2 | E1.1's two-instance e2e and E2.3's two-leader soak both pass against Postgres | both green on libsql at phase start | a dialect regression — the point of re-running them |
| E4.3 | `data_model.unindexed_ref_count` = 0 | **1** (`workspace_issue_members.workspace_id`) | the index not added, or a new unindexed FK introduced by the rewrite |
| E4.4 | `data_model.fk_coverage` still 1.00 (66 of 66) | **1.00** | the regenerated baseline dropping a foreign key — the classic silent loss in a dialect port. *Mild **A3** (already true at phase start): kept as a hold-the-line invariant because the dialect port is exactly what can break it* |

**Risks**: the migration corpus is discarded, so a botched baseline is not recoverable by replay.
P4 runs against a copy first; that is what E4.2 checks.

### Phase 5 — Decommission & harden

- **P5.1** `KANBAN_DB_URL` becomes required; the `~/.agentic-kanban/kanban.db` fallback is removed.
  With it go the file-location defences it existed for — the 12,288-byte size floor, the
  board-content probe, the stub-rename, the `.last-cli-db-path` warning. (S)
- **P5.2** Remove the P1.4 follower degradations that P2.6 made unnecessary; keep the ones that are
  genuinely machine-bound (worktrees live on one filesystem). (S)
- **P5.3** CI gates: the P0.2 handle-opener ratchet, the P1.1 scope-tag ratchet, the P1.4
  `updatedAt` ratchet and the P2.1 writer ratchet, all blocking. `analyze --fail-on-violations`
  joins them **only if** a genuine layer/forbidden-edge rule is declared in Phase 0 — the DB-handle
  rule is not one (P0.2). (M)
- **P5.4** *Optional, and out of scope unless the 30 s poll proves inadequate*: cross-instance
  push events. The port already exists (`BoardEventSink`, one wiring line), but the transport is **not** a
  one-constant change: loopback is assumed in 12+ production sites (F13). Size it against that,
  not against the port.

**Exit criteria**

| # | Criterion | Phase-start value | What turns it red |
|---|---|---|---|
| E5.1 | With `KANBAN_DB_URL` unset the server refuses to start (no silent local fallback) | today it falls through to `~/.agentic-kanban/kanban.db` | the fallback surviving |
| E5.2 | The two-leader soak (E2.3) still passes with the P1.4 degradations removed | green *with* the degradations | removing a degradation that was load-bearing |
| E5.3 | All four ratchets (P0.2, P1.1, P1.4, P2.1) run in CI **as blocking jobs**; `analyze --fail-on-violations` joins them only for a declared layer rule (a `warn`-severity gate would be **A4** and does not count) | the ratchets exist from their phases; CI runs none of them | a job wired non-blocking; an allowlist grown to make it green; a bypass merged |

## 6. Verification of the load-bearing claims

| # | Claim | Kind | Check **as performed** | Verdict |
|---|---|---|---|---|
| F1 | `KANBAN_DB_URL`/`DB_URL` already accepts a **remote** endpoint and wins over every other DB-location rule — so a shared database needs no dialect work | absence-of-blocker / doc-endorsement | Read `server/src/lib/env-registry.ts:49-53` (*"Explicit libsql connection URL; wins over every other DB-location rule"*); `shared/lib/db-path.ts:226` (*"remote libsql endpoint … has no on-disk path/dir"*); `db/data-dir.ts:23` (*"A non-`file:` DB_URL has no dir, so fall back to the home dir"*); test `shared/__tests__/db-path.test.ts:539-542` — `DB_URL: "libsql://board.example.com"` resolves with `source = "DB_URL"`, `path = null`. Also checked that the boot-time `VACUUM INTO` backup, which needs a local file, is wrapped in try/catch and logged non-fatal (`startup-tasks.ts:196-198`) | **confirmed** — the whole Phase-1 shape rests on this |
| F2 | `packages/server/src/db/index.ts` is **not** the sole opener of a database handle | exclusivity (negative) | Spellings tried: `createClient(`, `new Database(`, `new DatabaseSync(`, `new sqlite.DatabaseSync(`, `better-sqlite3`, `bun:sqlite`, `libsql`, `DATABASE_URL`, `DB_URL`, `KANBAN_DB_URL`, `kanban.db`, `.db`. Enumerated production openers: `db/index.ts:28`, `:43`; `mcp-server/src/db.ts:42`; `db/backup.ts:137`, `:171`, `:196`, `:368`; `shared/lib/db-client.ts:92`; `shared/lib/db-path.ts:146`; `server/query62.cjs:1-2`; `scripts/rework-loop-analysis.mjs:182`; plus `scripts/db-repair.ts` and `scripts/seed-example-session.ts` via `createClientWithPragmas`. **12 sites, 9 modules** | **confirmed** |
| F3 | `runMigrations()` runs at server boot **and on every CLI command** | count | `grep -rn "runMigrations\|applyMigrations\|runMigrationsForAction"` over `packages/*/src`, `scripts`, excluding tests. Definition `manual-migrate.ts:371`; boot `startup-tasks.ts:171,201`; `cli/shared.ts:173` wraps **every** commander handler via `cliAction`; 8 explicit calls (`cli/index.ts:142,148`, `cli/commands/{backlog:41,82, create:44, register:31, session:353, system:47,216, workspace-wait:54}`); scripts `db-migrate.ts:16`, `db-repair.ts:258` | **confirmed** |
| F4 | There is **no migration lock of any kind** | absence | Searched the *shape*, not the word: `advisory_lock`, `advisoryLock`, `lockMigration`, `BEGIN IMMEDIATE`, `FOR UPDATE`, `migration.*lock` across `manual-migrate.ts`, `startup-tasks.ts`, `scripts/db-migrate.ts` → **0 hits**. Repo-wide lockfile machinery exists (`lib/machine-verify-lock.ts`, `shared/lib/repo-lock.ts`) but neither is imported by the migrator. Also searched `BACKLOG.md`, `CONTINUE.md`, `docs/decisions/` for prior thinking → 0 | **confirmed** |
| F5 | The in-memory `claimIssueForAutoStart` guards only the auto-start path; other doors create `workspaces` rows without it | exclusivity | Grepped the **target** (`workspaces` rows), spellings tried: `insert(workspaces)`, `insert(schema.workspaces)`, `INSERT INTO workspaces`, `insertWorkspaceRecordRow`, `createWorkspace`. Enumerated writers: `repositories/workspace-crud.repository.ts:87`; `repositories/followup-workspace.repository.ts:98`; `repositories/workflow-fork-children.repository.ts:61,87,106`; `mcp-server/src/tools/start-workspace.ts:130`; `scripts/seed-example-session.ts:42`. Callers of the claim: `routes/workspaces.ts:352,368`, `dependency-auto-chain.service.ts:226`, `dependency-wave.service.ts:244`, `plugin-loop-start.service.ts` — none of them the MCP or CLI door. MCP `start-workspace.ts:79` calls `gitService.createWorktree` **in the MCP process** and inserts at `:130` | **confirmed — and it refutes a code comment.** `services/workspace-branch-create-claim.ts:83-85` asserts "*in-process exclusion covers every real create path (HTTP, monitor, CLI-through-HTTP, MCP-through-HTTP)*". MCP `start_workspace` is not MCP-through-HTTP; it is a second process creating a worktree and a row directly. The comment is wrong **today**, before any shared database |
| F6 | Zero identity: no user / actor / owner column anywhere | absence | `grep -rniE "user_?id\|actor\|owner_?id\|created_?by\|account"` over all 48 files in `packages/shared/src/schema/` → one hit, a doc comment on `plugins.id`. No `middleware/` auth file. Corroborated by the code's own statement, `lib/cors-origin.ts:4-5`: *"The board is a single-user, local-first app with NO API auth (any process on the box has full board authority — by design)"* | **confirmed** |
| F7 | 17 transactions against 559 write sites in `packages/server/src` | count | `grep -rn "\.transaction(\|withTransaction("` (prod only): server 17, shared 5, mcp-server 3. `grep -rn "\.insert(\|\.update(\|\.delete("` (prod only): server 559. Two differently-shaped queries were **not** run for the 559 — it is a lower bound on write sites and is used only as an order-of-magnitude contrast, never in an exit criterion | **confirmed (17); the 559 is a floor** |
| F8 | `workspace-provisioning` decides ownership by `server_pid != process.pid`, from a boot-time task | exclusivity / count | Read `repositories/workspace-provisioning.repository.ts:65-70`; the only caller is `startup-tasks.ts:740` inside `reconcileAbandonedProvisioning`, registered in the **startup task list** at `startup-tasks.ts:959` — *not* in `BACKGROUND_SERVICES`. This is why P1.3 cannot be deferred behind P1.1's sweep gate | **confirmed** |
| F9 | The event bus is already a port with one wiring line | exclusivity | `grep -rn "createBoardEvents("` (prod) → definition `services/board-events.ts:75`, one call site `startup/core-services-wiring.ts:36`. Port declared at `board-events.ts:273` (`BoardEventSink = Pick<BoardEvents,"broadcast"|"broadcastActivity">`) | **confirmed** |
| F10 | "19 sweeps registered in `background-services.ts:88-320`" (from a seam report) | count | Re-derived with a differently-shaped query: `grep -rln "startPeriodicSweep("` (prod) → **17** modules; `BACKGROUND_SERVICES` (`background-services.ts:73`) has **22** entries; the consumer is the loop at `server-start.ts:149`. The report's "19" and its line range were both approximate | **weakened → corrected**: 22 background services, 17 of them periodic sweeps. The plan uses the corrected figures |
| F11 | "80 of 92 MCP tools write SQLite directly" — inherited from `docs/plans/2026-08-26-…:323` | second-hand | Re-derived twice. `ls packages/mcp-server/src/tools/*.ts` (non-test) = **94**. Query A (seam agent, drizzle ops on `deps.db`) = **41**. Query B (mine, `deps\.db\|db\.(select\|insert\|update\|delete)\(`) = **38**. `board-call` importers = 25; `db-utils` importers = 81 — and `db-utils` is a *helper taking a handle*, which is where the 80 came from | **refuted (the 80/92) and weakened (its replacement)**: the true figure is 38–41 of 94; two queries disagree by 3. **No exit criterion rests on it**, and the plan says "38–41" wherever it appears |
| F12 | The design docs record this goal as an explicit non-goal | doc endorsement (against) | Quoted in full, each read on its own: `CLAUDE.md:14` — *"**Local only** — no cloud/multi-tenant/OAuth."*; `docs/prd.md:222-223`, under **Non-Goals (Explicitly Skipped)** — *"Multi-tenant / organizations / team collaboration"*, *"Cloud deployment / PostgreSQL / ElectricSQL"*; `docs/prd/01-features-catalog.md:469` — *"Cloud deployment \| PostgreSQL + ElectricSQL \| SKIP — local only"*; `docs/provider-requirements.md:61` — *"Cloud-hosted/multi-user auth flows \| All \| Out of scope for this local-first app."*; `docs/domain/mcp-server.md:147` — *"No authentication / authorization on the surface… This is intentional for a local-first single-user app."* Each quote survives being read alone | **confirmed** — and note it is a *derived* exclusion: `docs/competitors/vibe-kanban.md:63-67` records that the upstream project this reimplements *does* ship PostgreSQL for its remote mode, and this repo chose not to copy it |

| F13 | "The one out-of-process ingress hardcodes `127.0.0.1`" — **my own draft's** exclusivity claim, caught by the mandatory self-grep | exclusivity | Enumerated the target (paths by which another process reaches this board), spellings tried: `/api/internal`, `board-notify`, `boardApiUrl`, `boardApi`, `LOOPBACK_HOST`, `127.0.0.1`, `localhost:3001`, `http://localhost`. Found **two** internal notify routes (`mcp-server/src/notify.ts:10` board-notify, `:25` workflow-advanced), the whole `board-call` path used by 25 MCP tools (`mcp-server/src/board-call.ts:17`), and **12+ further production sites that hardcode loopback outside the URL helper** — `cli/commands/butler.ts:41,219`, `cli/commands/session.ts:28`, `cli/commands/worker.ts:27,73`, `cli/commands/workspace-api-url.ts:24`, `cli/commands/system.ts:195`, `builtin-skills.ts:757,786,848` | **refuted.** The claim is removed from the plan's reasoning; §3 S4 and P5.4 are re-sized accordingly (S → M, and P5.4 stays optional) |
| F14 | `BACKGROUND_SERVICES` is **not** the only registry of boot-time work that acts on shared rows — raised by the round-1 reviewer against my own draft, then re-derived here | exclusivity (negative) | Read `startup-tasks.ts:918` — `STARTUP_AUDIT_TASKS` declares **11** entries (`reapOrphanedPluginViewProcesses`, `reapParentlessChildServers`, `reconcileStrandedSiblingMerges`, `reconcileAncestorBranchWorkspaces`, `reconcileHandMergedBranches`, `scanDoneUnmergedWorkspaces`, `reapTerminalWorkspaces`, `pruneStaleWorktrees`, `pruneOrphanedWorktrees`, `reconcileAbandonedProvisioning`, `checkMainCheckoutHeads`). `runStartupAuditTasks()` is defined at `:963` and called at `server-start.ts:131` — a **different** call site from the `BACKGROUND_SERVICES` loop at `:149`. The array's own header (`:908-916`) says these "CONVERGE state rather than gate it… which is why this runs **ungated**, with no request waiting on it", justified by idempotence | **confirmed, and it breaks the first draft's Phase 1.** The idempotence argument holds for *one* process against *one* database; under this goal a follower's boot converges shared rows against *its own* git checkout and disk. The reviewer's count of 12 entries is off by one (11); the finding is unaffected. F8 had found the mechanism and applied it to a single entry |
| F15 | `sqliteTable` "47" is a **file** count, not an occurrence count | count | `grep -rc "sqliteTable(" packages/shared/src/schema/` → **57** occurrences across **47** files. Raised by the round-1 reviewer; reproduced | **corrected in E4.1** (both numbers now stated). The reviewer's companion figure — 62 `PRAGMA` occurrences in production TS — I could **not** reproduce; my count is **57** both before and after. Recorded as a disagreement; the target is 0 either way and nothing rests on the phase-start number |

**Unverified, carried as such** (never omitted):
- The **~2,150 LOC** of SQLite/libsql defect mitigation and the **~11** `json_extract`/`group_concat`
  sites are a seam report's figures; I did not re-count them. `unverified (second-hand from the S1
  seam report)`. No exit criterion uses either.
- The **27** `integer({mode:"boolean"})` columns and the claim of **0** `mode:'timestamp'` /
  0 autoincrement: `unverified (second-hand from the S1 seam report)`. E4.1 counts `sqliteTable`
  and `PRAGMA`, which I did verify (47 and 57), not these.
- The characterisation of the in-memory claim registry and pid+hostname repo lock in the *prior
  plan*: `inherited, not re-derived` by the S1 report; re-derived independently by the S2 report
  and by F5/F8 here.
- Whether a follower is genuinely inert: **not verifiable by reading**. It is E1.1's job.

## 7. Adversarial review (step 6b)

**Rounds**: three, each one generalist reviewer against the full rubric R1–R8, each fresh (no
access to the previous reviewer's report, only to the plan and this section). Round 1 on the first
complete draft; round 2 because round 1 moved the **insertion point** of Phase 1's central
behaviour, which the pipeline's termination rule says owes a further scoped round; round 3 for the
same reason after round 2 moved it again — and three is the hard cap. Before round 1, a cheap
falsifiability pass (6b-0) swept all 21 exit criteria against the fixed anti-pattern list A1–A10.
**Every round found a Phase-1 defect that would have shipped**, and each found it by a method the
previous round had not used.

**Round 1 verdicts**: R1 PASS · R2 PASS · R2b **WEAK** · R3 PASS · R4 **WEAK** · R5 **WEAK** ·
R6 PASS · R7 **WEAK**.

*Rows below cite the criterion numbering **of their own round**; Phase 1 was renumbered by each re-cut, so read the fate column against the final tables in §5.*

| # | Major finding | Fate | Where in the plan |
|---|---|---|---|
| 1 | "A follower registers none of the 22 `BACKGROUND_SERVICES`" is not the gate the plan thought it was: `STARTUP_AUDIT_TASKS` (`startup-tasks.ts:918`, 11 entries) runs **ungated on every boot** from a *different* call site, `server-start.ts:131`, and includes reconcilers that merge branches, prune worktrees and kill processes by pid | **integrated** | P1.1 now gates three entry points and names all 11 tasks; new **E1.5** (scope-tag wiring test + ratchet); §6 **F14**; §8 residual |
| 2 | E1.2 measured the *gate* (`grep process.pid` under `repositories/`) instead of the *target* (pid values reaching a column) — and got the gate's own count wrong | **integrated** | **E1.2** rewritten per column, with a named allowlist and the 21-site production figure |
| 3 | The contradiction with the 2026-08-26 team-capable plan is *reported* but never *adjudicated*; two live plans for one motivation is a decision the plan should force, not describe | **integrated** | P0.1 must settle it and mark the loser superseded; new **E0.4**; §9.2 rewritten as a recommendation |
| 4 | The migration lease has no bootstrap story (on an empty shared database the migration corpus is itself what races) and "the other skips" is unsafe — the loser must wait, or it serves a half-migrated schema | **integrated** | P1.2 (lease table outside the corpus; blocking wait + timeout); **E1.3** now asserts the cold-start case |
| 5 | Three exit criteria rest on values that are not pinned or are mis-pinned: E0.2 ("measured at pin" = **A2**), E4.1 (file count quoted as occurrence count), E3.3 (no inventory, and judged by reading = **A9**) | **integrated** | P0.2 pins all of them numerically; E0.2, E3.3 (route-table walk), E4.1 rewritten; §6 **F15** |
| 6 | E3.4's phase-start "5" came from a column-name substring screen, so it is a floor presented as a total | **integrated** | E3.4 now states 5 as a reviewed floor and names the screen's limit |
| 7 | Follower freshness is weaker than the plan claims (now P1.8): a follower's WebSocket only ever carries its *own* server's events, and the 30-second fallback poll is **visibility-gated**, so a backgrounded follower tab is stale indefinitely | **integrated** | P1.8 states the mechanism and drops the visibility gate in follower mode; E1.3 asserts propagation through A's **API**, not through a UI; §9.6 |

**R8 comparison** — the reviewer's one-phase alternative reached the same user-visible outcome as
the plan's Phase 1 with **less**: gate the boot audit and the sweeps, take the migration lease, and
**drop the four `owner_instance` columns entirely**, because while exactly one instance acts,
pid-scoped ownership is correct by construction. That is strictly cheaper and strictly more
reversible, so the plan's phase order was re-cut: P1.3's columns became **P2.0**, and Phase 1 gained
**E1.6** (zero migrations), which is what now keeps its kill switch a single environment variable.

**Minor findings** integrated silently: the `BACKGROUND_SERVICES` consumer is at `server-start.ts:149`
(the draft cited :138, a line inside a comment); `cli/commands/workspace.ts:171` calls
`insertWorkspaceRecordRow` and is not itself a `workspaces` writer, so F5's list is 7 sites in 3
processes with the CLI *not* among them; `cors-origin.ts`'s statement is at lines 4-5;
`rowsAffected` is libsql-shaped and needs an adapter for drizzle-pg's `rowCount`;
`KANBAN_BOARD_ROLE` must be registered in `docs/env-vars.md` as well as the env registry, or the
parity test fails; P2.2 must name what replaces `loop-advance-lock`'s queueing behaviour; E2.2's
"≥ 32 `withTransaction` sites" was an invented target and was dropped.

**Round 2 verdicts** (scoped to the re-cut Phase 1 and R7 over the sequence): R1 PASS · R2 PASS ·
R2b **FAIL** · R3 PASS · R4 **WEAK** · R5 PASS · R6 PASS · R7 **FAIL**.

| # | Major finding | Fate | Where in the plan |
|---|---|---|---|
| 1 | **The re-cut's central claim was false.** Gating three call sites does not make a follower inert: a sweep of the composition root found at least eight independent entry points. The worst, `cleanupStaleSessions` (`startup-tasks.ts:348-380`, inside `runBootSequence` at `server-start.ts:52`), selects **every** `sessions` row with `status="running"` and no worker — no instance scope — probes `isPidAlive` against *this* machine's process table and writes `status:"stopped"` + workspace `idle`. **A follower boot would stop every running agent session of the leader.** Also `runGatedDeferredStartupTasks` (`:123`, of which `runStartupAuditTasks` is only the `.then()` tail), `cleanupExpiredRuntimeState` (`:211`), `ensureGitHttpServer` (`:190`), and worker-WebSocket writes with no HTTP request at all (`route-setup.ts:42-43` → `worker-fleet.service.ts:97-112`) | **integrated** | Phase 1 re-cut a second time (round 3 then re-cut it again, see below); the eight entry points are named in P1.2/P1.3; E1.9 covers 37 registry entries |
| 2 | Every boot unconditionally rewrites shared settings and runs DDL: `preferences.auto_monitor` upserted to `"false"` (`startup-tasks.ts:259-262`) — a follower boot silently disables the leader's monitor — plus `deduplicateProjects`, `unregisterLeakedTempProjects`, builtin seeding that updates `issues.currentNodeId`, and `alignForeignKeyActionsOnStartup` (`fk-alignment.ts:42`) which **rebuilds drifted tables** | **integrated** | named in P1.3; `alignLiveDbForeignKeys` moved behind the migration lease **for the leader too**; **E1.1 became a byte-level whole-database diff**, because a hand-picked row set would have missed `preferences` |
| 3 | `monitor-setup.ts:189` is not an insertion point — it is `let cycleRunning = false;`. `createMonitorSetup` is invoked at `server-start.ts:57`, before everything the plan gated, and on construction registers a `boardEvents` listener and calls `healWorkspaceSummaryProjection(db)`, which **writes** | **integrated** | re-anchored to `:57`; the constructor's writes are what `startMonitorRuntime()` isolates in P1.2 |
| 4 | P0.2's `[architecture]` rule **cannot be expressed**: code-metrics' `[architecture]` section accepts only `layers` and `forbidden` module→module edges (`config.py:266-270,468-470`), so a file allowlist and a symbol rule are undeclarable — E0.1 and E5.3 were unrunnable | **integrated** | P0.2's handle rule became a repo-local shrink-only ratchet test; E0.1 and E5.3 rewritten; `--fail-on-violations` kept only for a genuine layer rule |
| 5 | Phase 1 left the follower's **MCP server** ungated — it holds its own handle and writes directly (`start-workspace.ts:130`, `close-workspace.ts:45-57`), so capability row C10 had no Phase-1 item | **integrated** | now **P1.6**; **E1.8**; E1.1 runs B's MCP server too |
| 6 | Round 1's R8 conclusion was too broad: pid columns are **read** on request-driven paths (`workspace-cleanup.service.ts:61-71` kills a process tree from a shared pid; `remote-session-liveness.ts:133` returns a user-visible verdict; `worktree-claim.ts`), none gated | **integrated, by the cheaper of the two options offered** | the deny-by-default middleware (now P1.5) 409s those three paths on a follower; the `owner_instance` columns stay in P2.0 so E1.6 can keep Phase 1 migration-free. The cost — a follower cannot answer "is this session alive?" until Phase 2 — is stated in P1.5 |
| 7 | E1.6 contradicted itself ("adds no column and no table… the lease table is a `CREATE TABLE IF NOT EXISTS`"), and P1.5's CAS column is not maintained by four `issues` writers, so a CAS would silently overwrite them | **integrated** | E1.6 reworded to "schema objects added: exactly 1"; P1.7 makes every `issues` writer bump `updatedAt`, with a ratchet |

**R8 comparison (round 2)** — the reviewer's one-phase alternative had the *same* scope and the
same timing as the re-cut Phase 1, and it said so: "the phase order stands; only Phase 1's
mechanism must be re-cut." Its one structural contribution — gate by omission at the composition
root rather than by enumerating registries, because "omission at the composition root is provable;
enumeration of registries has now failed twice" — is the change adopted above.

**Minor findings** integrated silently in round 2: the kill switch strands rows written since
cutover (now in P1.7); `isPidAlive` (`lib/pid.ts:23`) fails toward *alive* while `worktree-claim.ts`
fails toward *dead* — unified in P2.0, which also copies `plugin_view_processes`' command-line
cross-check (`startup-tasks.ts:469`), the only pid table that has one; shutdown's
`PRAGMA wal_checkpoint(TRUNCATE)` and `db/index.ts`'s import-time `applyPragmas()` are Phase-4
items a shared libsql endpoint already strains, now named in Phase 1's do-not-build list.

**Round 3 verdicts** (final round, scoped to the twice-re-cut Phase 1 and R7 over the sequence):
R1 PASS · R2 PASS · R2b **WEAK** · R3 PASS · R4 **WEAK** · R5 PASS · R6 PASS · R7 **WEAK**.

| # | Major finding | Fate | Where in the plan |
|---|---|---|---|
| 1 | Skipping `runGatedDeferredStartupTasks()` **strands the readiness gate**: `markStartupComplete()` has exactly one production call site, `server-start.ts:126`, inside that promise's `.finally`, and `readiness.ts:60-83` holds every non-GET request for `READINESS_GATE_TIMEOUT_MS = 120_000`. A follower would take two minutes per edit — the phase's entire user-visible outcome | **integrated** | P1.5 calls `markStartupComplete()` immediately; **E1.2** asserts the first POST completes in under 1 s |
| 2 | "Skip `runBootSequence` except the migration verify" is not a separation the code offers: `runCriticalStartupTasks` is four calls (`startup-tasks.ts:863-868`) and **every shared-row write attributed to boot lives inside `runMigrations()` itself** — builtin seeding, `deduplicateProjects`, `unregisterLeakedTempProjects`, a hook-wiring sweep with `repair: true` that writes **to disk in the leader's repos**, the `auto_monitor` upsert, the default-model migration. Keeping the verify keeps all of them | **integrated** | new **P1.3**: split `verifySchemaVersion()` (pure read) from `applyMigrationsAndSeed()` (leader, behind the lease); E1.4 asserts the read path never seeds; E1.7 budgets `startup-tasks.ts` |
| 3 | The omission list **missed a third ingress**: `startFleetListener` (`server-start.ts:163`) sits in the same `if (fleetPort !== null)` block as the gated `ensureGitHttpServer` (`:190`) and binds an **off-loopback** surface accepting `POST /api/workers/register`, `/heartbeat`, `/incoming/land`, `/incoming/discard`. Evidence the sweep was line-anchored rather than block-anchored | **integrated — and it changed the mechanism** | the whole `fleetPort` block moves to `leader-runtime.ts` (P1.2), and P1.5's middleware denies `/api/workers/**` rather than only the socket |
| 4 | Three of the omissions **break the follower as a reader**, which the phase promises: `createMonitorSetup` cannot be skipped in isolation (`:58`, `:59` consume it) and `setupMonitorRoutes` is the sole registrar of `GET /api/internal/monitor-status`, polled by `useBoardPreferences.ts:119,150` on every board load and every 30 s in every tab | **integrated** | `createMonitorSetup` split: `registerMonitorRoutes` (follower, inert state) vs. `startMonitorRuntime()` (leader) in P1.2/P1.5; **E1.2** asserts zero 404s on a follower's board page |
| 5 | E1.2 (old) was an **A10** — its own phase forbade satisfying it: the leader legitimately writes pids, the replacement column is deferred to P2.0, and E1.6 bans new columns | **integrated** | restated as **E1.5** ("no *follower* writes a pid to a column", asserted by the byte diff); the absolute form moved beside E2.4 |
| 6 | E1.4's "+4 CC" was infeasible: seven omission points plus the readiness call is +7 or +8 minimum, so the only ways to hit +4 were the two the criterion exists to forbid | **integrated** | **E1.7** requires a *shape* — one `if` plus a moved `leader-runtime.ts` — with `server-start.ts` at +2 and the move unconstrained |
| 7 | The role is per-process across three processes, but P1.1 said it was read "only in `server-start.ts`" — and an MCP process launched from an editor config without the env var silently reverts to `leader` and writes `workspaces` rows | **integrated** | `resolveBoardRole()` moved to `packages/shared/src/lib/`, and the default becomes **`follower` whenever the DSN is remote and the role is unset**; **E1.8** tests exactly that process |

**R8 comparison (round 3)** — the reviewer's alternative reached the same outcome in the same phase
but inverted the mechanism: **deny-by-default** (mount everything, refuse everything not
allowlisted) instead of enumerate-and-omit, because "did we find every writer?" had by then failed
three times (F14, the MCP process, the fleet listener) while a middleware is provable by reading one
file. Adopted in full: it is now P1.5, and it is why Phase 1's shape stopped changing for safety
reasons and started changing for *reader-fidelity* reasons.

**Minor findings** integrated silently in round 3: `issues.updatedAt` is a `$defaultFn`, i.e.
application-side, so raw SQL (`seed-example-session.ts:42`) bypasses it — said in P1.7; the
`P1.4`/`P1.5` cross-references left over from the round-2 re-cut were corrected throughout;
`killOrphanedServers` is win32-only and keyed on `process.cwd()`, not a shared-row writer, and was
dropped from the "what it stops" narrative; `cleanupExpiredRuntimeState` deletes only TTL'd rows and
needs no defence; `scripts/db-repair.ts` and `scripts/db-migrate.ts` stay ungated writers on a
follower machine, which P0.2's ratchet does **not** catch — carried in §8.

**Rounds line**: 3 rounds run, 3 rounds' findings integrated, **21 majors** total, of which **21
integrated, 0 rejected, 0 recorded as shortcomings of the review itself**. Phase 1 was re-cut after
every round. Round 3's re-cut owes a fourth round that the pipeline's hard cap forbids — see §8.

## 8. Known shortcomings

- **The goal reverses recorded product intent in five documents (F12), and no measurement can
  settle whether it should.** The plan can only insist that P0.1 makes the reversal explicit and
  narrow. Owner: whoever owns the product direction.
- **This plan and `docs/plans/2026-08-26-team-capable-modernization-plan.md` are mutually
  exclusive architectures for the same motivation.** One says the shared truth is a remote tracker
  and each developer keeps a private database; this one says the shared truth is one database.
  Doing both means two sources of truth. Owner: the team, via §9.
- **Hosting is out of the data's reach.** Who runs the shared endpoint, where, with what backups
  and what network trust boundary, is not answerable from the repo. Owner: the team.
- **`--rework` and all 26 scorecard targets are unusable here** (convention artifact; defaulted),
  so the plan has no *headline health* exit criterion — only structural and behavioural ones.
- **The final re-cut is unreviewed, and the pipeline's cap is why.** Round 3 changed Phase 1's
  mechanism again (enumerate-and-omit → deny-by-default), which by the same rule that triggered
  rounds 2 and 3 owes a fourth round; three is the hard cap, so it was not run. **What is
  specifically unreviewed**: P1.5's allowlist (is "issue CRUD, comments, sort order, tags" the right
  set, and does any allowlisted route write outside `issues`?), P1.3's `verifySchemaVersion` /
  `applyMigrationsAndSeed` split (does any read path still need something the seed half provides?),
  P1.2's `registerMonitorRoutes` / `startMonitorRuntime` split, and E1.2's new assertions. The
  pattern across three rounds is a warning in itself: each round found a Phase-1 defect the previous
  round's method could not see. **Treat Phase 1 as designed but not yet proven, and spend the first
  implementation day on E1.1 and E1.2 rather than on the work items.** Owner: whoever implements
  Phase 1.
- **`scripts/db-repair.ts` and `scripts/db-migrate.ts` remain ungated writers** on a follower's
  machine — they open a handle through the resolver and act. P0.2's ratchet catches *new* handle
  openers, not these two. Owner: Phase 1 implementation (a role check in `cliAction`'s siblings) or
  Phase 5's decommission.
- **A follower's inertness cannot be established by reading.** Round 1 found one entire registry
  of ungated boot-time reconcilers (`STARTUP_AUDIT_TASKS`, §6 F14) that the first draft missed
  after an explicit enumeration pass. Nothing proves there is not a third. Only E1.1's repeated
  follower reboot against a live leader can find one; treat a green E1.1 as the evidence and the
  enumeration as the hypothesis, never the other way round. Owner: whoever implements Phase 1.
- **A follower's UI freshness is bounded by a poll, not by an event.** Its WebSocket carries only
  its own server's events, so ≤ 30 s is the *design*, not a limitation of this plan's sequencing;
  P5.4 is the only fix and it is optional. Owner: the team, via §9.6.
- **`workspaces` is a 38-column god table with 42 production consumers** and this plan adds to it.
  It is not on the critical path of any capability row, so it is not a work item — but a future
  split will be more expensive after Phase 3.

## 9. Open decisions for the team

1. **Postgres from day one, or a shared libsql endpoint first?** The plan's order works either
   way; only Phase 1's endpoint changes. Choosing Postgres immediately front-loads an L item
   (47 schema files, a regenerated migration baseline) before any of the measured defects are
   touched. Choosing libsql first means running a libsql server or Turso, which is its own ops
   decision.
2. **This plan or the 2026-08-26 team-capable plan?** Shared database of record versus external
   tracker as source of truth. They overlap rather than compose: capability rows C1, C4 and C6
   have a different mechanism in each, and running both means two sources of truth for the same
   rows. **Recommendation**: pick this one *if* the team wants agent orchestration shared, and the
   other *if* the team wants the tracker to stay authoritative and only the humans to share — then
   mark the loser superseded in its own header (E0.4). What must not happen is both staying live
   and un-marked, which is today's state.
3. **What is the conflict rule for concurrent edits to one issue?** P1.7 proposes optimistic
   concurrency with a 409; last-write-wins and field-level merge are the alternatives.
4. **Is a developer's board instance trusted?** P3.2's answer determines whether authentication is
   per-developer or per-instance.
5. **Which machine is the leader, and does leadership need to fail over automatically?** P1.1
   assumes a configured leader; P2.6 assumes it must not stay that way.
6. **Do followers need push updates, or is a 30-second poll acceptable?** The plan assumes the
   poll and puts push in P5.4 as optional. Note the honest bound: a follower's WebSocket never
   carries the leader's events, and the fallback poll is visibility-gated today, so "≤ 30 s" holds
   only once P1.8 makes it unconditional. If a stale backgrounded tab is unacceptable to the team,
   P5.4 moves forward and is sized against F13's 12+ hardcoded-loopback sites, not against the
   one-line event port.

## 10. How to re-measure

```
CM=<code-metrics-repo>/.venv/Scripts/code-metrics.exe
$CM baseline pin C:/projects/andrena/agentic-kanban --label shared-db-phase0     # Phase 0
$CM analyze C:/projects/andrena/agentic-kanban -o out --days 180
A=out/analysis.json
$CM query $A --class refactor_first --top 40      # E1.7 companion: are the edited files rising?
$CM graph $A --stats                              # E1.9 / E2.4: pin and diff the dependent lists
$CM graph $A --dependents-of packages/server/src/db/index.ts
$CM graph $A --dependents-of packages/shared/src/schema/index.ts
$CM refactor $A --boundaries                      # server↔shared leakage over time
$CM query $A --tangle                             # only with --history-ref <phase-start-sha>
$CM analyze <repo> --fail-on-violations           # E0.1 / E5.3, once [architecture] is declared
python -c "import json;d=json.load(open('out/analysis.json'))['data_model'];print(d['unindexed_ref_count'], d['fk_coverage'])"   # E4.3 / E4.4
```
Always pass `--history-ref <phase-start-sha>` to `compare` and `--tangle`, so the refactor's own
churn is frozen out of the comparison.

## 11. Cost of producing this plan

One session, **≈ 1 h 20 min wall clock** (2026-09-01, 12:27–13:45 local), on a shared 16-core /
28 GB machine with other sessions live — so the fan-outs were capped at 2 concurrent subagents by
`fleet gate`, not by the pipeline.

| Step | Spend |
|---|---|
| 0 · goal framing | ~5 min, no subagent |
| 1 · measurement | ~14 min; **18 `code-metrics` invocations** (1 × `analyze` producing a 43.5 MB `analysis.json`, then 17 × `query` / `graph` / `refactor` / `structure` over it) |
| 2–3 · seams and fan-out | 4 seams named, **2 read-only seam subagents** (S1 alone; S2+S3+S4 together, because they share the same services and registry files) |
| 4–5 · overlay and skeleton | ~20 min, **1 cheap skeleton reviewer** |
| 6a · fact refutation | ~25 min, no subagent — 15 facts checked, 3 refuted or weakened, including one of the plan author's own exclusivity claims caught by the mandatory self-grep |
| 6b-0 · falsifiability sweep | ~6 min, **1 cheap subagent** over the criteria tables alone |
| 6b · adversarial review | **3 rounds, 3 fresh subagents**, ~8 + ~5 min of agent time for rounds 2 and 3 (130.9 k and 117.8 k tokens respectively; round 1's usage was not recorded). Each round re-cut Phase 1 |
| 7 · delivery | this file |

**7 subagents in total.** The review rounds were roughly a third of the wall clock and produced the
three largest changes in the document; the measurement step, by contrast, was cheap and mostly
confirmed what a careful reading would have found. The one number worth budgeting against for a
comparable repo (~3,100 files, ~424 k SLOC, 7,073 commits): **a plan of this depth costs about two
hours and seven subagents, and more than half of that is spent proving the first phase wrong.**
