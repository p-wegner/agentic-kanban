# Team-capable agentic-kanban — modernization plan

Goal: a **team** of developers, each running the board + AI agents on their own machine (plus
optional remote workers), sharing **one Jira board as the source of truth** for the backlog, and
delivering through **real CI + PR/MR pipelines** with a review gate — instead of today's
single-user, local-first board with a private `kanban.db` and a local `--no-ff` merge into a
local `main`.

Produced with the `modernization-plan` skill (code-metrics-skill repo), revision 3 after two
adversarial review rounds (§7): round 1 re-cut the phases so a two-developer outcome lands in
Phase 1; round 2 re-shaped Phase 1 itself — event extraction before the `remote-pr` branch, an
atomic claim on the remote instead of a Jira field, a one-table tracker outbox, and ownership of
the asynchronous merge tail. This document is the *plan*; nothing in it has been implemented.

## Provenance

- Repo `agentic-kanban` at `056f77e230` (2026-08-26). Metrics snapshot: `code-metrics analyze`
  of that commit, 2026-08-26 14:28 UTC, **180-day** window, 2,976 files (production and test
  measured separately). All numbers below are from this snapshot (revision 1 had mixed in a
  2026-08-24 / 90-day snapshot — caught in round 1; two leftover stale figures caught in round 2).
- Goal framing §1 → 3 seams → 2 read-only subagents (RAM-capped at 2 concurrent; the box was
  paging). A 4th candidate seam (external contract / MCP) shared every file with seam 1 and was
  folded into it.
- Verification: 7 fact claims grep-checked (6 confirmed, 1 weakened — §6); then **two adversarial
  review rounds** (fresh generalist subagent each, N=1 per round, rubric R1–R8): round 1 — 7
  majors, 6 integrated, 1 integrated + shortcoming; round 2 on revision 2 — 7 majors, 7
  integrated (two of them by re-shaping Phase 1), plus 10 minors. Every reviewer claim was
  grep-checked before integration (§7).
- **Not measured / not trustworthy here:** class-level metrics (functional TS — UNMEASURED, not
  healthy); `--rework` (agent commits use `fix:` for follow-ups → 90–99 %, convention artifact,
  not used anywhere in this plan, including exit criteria); scorecard targets all defaulted
  (advisory); `--module-crime` **withholds** the `client ↔ server` and `mcp-server ↔ server`
  hidden-dependency rows (5 unresolved server imports) — so "hidden dependency gone" is not
  usable as an exit criterion; runtime behaviour, Jira API specifics, CI vendor.

## 1. Goal as capability delta

| # | Capability (target) | Quality demanded | Seam | Today |
|---|---|---|---|---|
| C1 | Backlog items are Jira issues; the board is a *projection* of Jira, not a store | replaceable source of truth; id/status translation; sync + conflict rule | **S1 issue model & writers** | own `issues` table, `#N` numbers, per-project status rows addressed by name |
| C2 | Board automation's status transitions land in Jira and vice-versa | async-capable; the single write authority becomes the sync hook | S1 | `transitionIssueStatus` is the single authority (#953) — local only |
| C3 | Agents/CLI/MCP all see the same backlog | externally contracted; one write path | S1 (+ MCP contract) | MCP: 80 of 92 tools write SQLite directly |
| C4 | N developers, each a local instance; nothing machine-specific in shared data; secrets never in shared data | multi-instance safe; identity-aware; secret-safe | **S2 identity, settings, project binding** | no user entity; one flat plaintext `preferences` map; project ≡ local repo path |
| C5 | Work lands via push → PR/MR → CI green → merge on the remote | landing as a two-valued choice; CI evidence as gate input; async gate | **S3 delivery** | local `--no-ff` merge into local main (`reset --hard` of the checkout); gate = local 26–44 min `verify_script`; zero outbound git/PR/CI |
| C6 | Two boards never race on the same ticket/branch | claim/lease outside any board | S2/S3 | in-memory claims, pid+hostname repo lock, per-board SQLite |
| C7 | Optional remote workers keep working | keep | S3 (exists) | worker fleet: pull model, typed versioned protocol, delivers to `refs/kanban/incoming/*` |
| C8 | External systems get notified of board facts | observable: payload-bearing events | cross-cutting | `board-events.ts` = WS invalidation, reason only; webhook fire-and-forget, loopback-only |

## 2. What the metrics say about the ground we build on

`code-metrics query / candidates / refactor --boundaries / graph` on the 2026-08-26 snapshot.

- **Kernel**: `packages/shared/src/schema/index.ts` — **561 dependents**, the most depended-on
  file; `server/src/db/index.ts` 241. C1/C4 add columns here → additive migrations only.
- **Hot-on-seam files** (`refactor_first`, 330 files in class): `SettingsPanel.tsx` **0.911** (#1),
  `server-start.ts` 0.908 (#2, composition root), `exit-workflow.ts` **0.856** (#6,
  `introduce_event` priority 0.611 — 8 cross-module calls), `workspace-merge.service.ts` **0.846**
  (#7, churn 117/180 d), `project.service.ts` **0.843** (#8), `issue.service.ts` **0.824** (#10,
  987 LOC; `split_responsibility` 0.689 → groups *issueerror / issueid / statusname*;
  `introduce_event` 0.477), `monitor-cycle.ts` **0.822** (#11, 43 fns, CC 41;
  `split_responsibility` 0.731 → *cycle / verificationresult / reason / processworkspacedeps*),
  `routes/issues.ts` 0.776 (#14), `plugin-loop.service.ts` 0.734 (#25),
  `get-board-status.ts` 0.712 (#27). Everything the goal touches is already risky → the plan's
  first slice is deliberately **additive** (new code at existing seams), and the splits come
  *after* the new semantics are known (§7 finding 1/R8).
- **Boundaries the work crosses** (`refactor --boundaries`): server ↔ shared co-change leakage
  **0.48** (9 pairs — the schema/DTO seam), client ↔ server 0.25, mcp-server ↔ server 0.23.
  `--tangle`: **48.6 %** of 2,947 logical changes touch ≥ 2 modules, **17.7 %** ≥ 3; containment
  `shared` **35 %**, `mcp-server` **24 %**. A Jira change is a ≥ 3-module change by construction.
- **Existing event mechanism**: `services/board-events.ts` (96 dependents) — reason-only. The
  three `introduce_event` prescriptions can land on it once it carries a payload.
- **Scorecard reds relevant to the goal**: centre of gravity 0.44 (target 0.7), 37 % of decision
  points in adapters, entanglement 0.138 (target 0.10). Explains why `SettingsPanel.tsx` is #1
  (policy lives in the UI); addressed only where S2 splits settings by scope.
- **Existing fitness machinery the plan must extend, not duplicate** (§7 finding 5):
  `.github/workflows/arch-gate.yml:41` runs `pnpm check:arch` (god-module + **dependency-cruiser
  layering** + mcp-catalog parity, #982); `packages/server/src/__tests__/status-write-ratchet.test.ts`
  is a grandfathered, tighten-only write ratchet.

## 3. Seams and their components

Class: **kernel** / **hot** (on seam + `refactor_first` or prescribed move) / **cold** / **contract**
(co-change without import edge). Size S/M/L relative; no per-finding costs declared.

### S1 — Issue source of truth & its writers

| Component | Files | Role today | Change for the goal | Class | Size |
|---|---|---|---|---|---|
| Issue schema | `shared/src/schema/issues.ts` (`externalKey` documented as the Jira slot, **overloaded by plugin-loop dedupe, #201**), `project-statuses.ts`, `issue-comments.ts` | owns model | split `source_key` out of `externalKey`; add `externalId`, `syncedAt`, `syncVersion`; `issueNumber` stays (display) | kernel | S–M |
| Status authority | `shared/lib/workflow-engine/status-transition.ts` (single authority, #953, ratcheted; `:47-53` best-effort try that swallows lookup failures; **runs inside the MCP process too** — 3 MCP tools call it), `status-transitions.ts`, `workspace-init.ts:88-90` (writes `statusId` directly on workspace creation — outside the hook) | legality by **name** | `onTransition` hook → **local write first, then enqueue** into a one-table `tracker_outbox` (retry, butler event after N failures) — neither swallowing nor half-updating a CC-28 caller; `workspace-init` routed through the hook; the MCP process needs the Jira token too, or its rows are drained by the server | cold | M |
| Status ↔ Jira map | — (new) | — | per-project `Map<jiraStatus, localStatusName>` in `.kanban/team.toml` (Phase 1); semantic roles replace name literals later (Phase 2) | cold | S then M |
| Status-name literals | 107 non-test files (server 56, client 38, shared 10, mcp 3) — e.g. `exit-workflow.ts:374,456,505,538`, `monitor-cycle.ts:280,437,549` | automation finds targets by `findStatus("In Review")` | Phase 2: roles + shrink-only ratchet | hot | M |
| Issue service + repos | `services/issue.service.ts` (0.824), `issue-service.repository.ts`, `issue.repository.ts` | server write path; archive/duplicate/contract are local row surgery | Phase 2: computed 3-way split; then a **Jira-only** client module in front of the write paths (no `IssueTrackerPort` with a local adapter — §7 finding 4) | hot | L |
| Other writers | 21 files / ~32–34 direct `insert/update/delete(issues)` sites: 8 server repositories, `workflow-engine/{status-sync,transitions,workspace-init}.ts`, `cascade-delete.ts`, CLI repo | writer families 3–5 | covered by the **extended** status-write ratchet (Phase 0) and rerouted in Phase 2 | cold | M |
| MCP tools | **80 of 92** import `../db` directly; 23 use `board-call.ts` | second full writer family; duplicates `issueNumber` allocation (`db-utils.ts:236`) | Phase 2: the write tools (create-issue, create-issues-batch, create-sub-issue, update-issue, move-issue, contract-coupled-issues) → `board-call`; reads later | hot + contract | M then L |

### S2 — Identity, settings, project binding, secrets

| Component | Files | Role today | Change | Class | Size |
|---|---|---|---|---|---|
| Team policy vs machine facts | `shared/lib/settings-registry.ts` (80+ keys, **no secret/encrypt notion**), `SettingsPanel.tsx` (0.911), `routes/preferences.ts`, `preferences.repository.ts` (94 dependents) | one flat plaintext global map | `team` scope → checked-in `.kanban/team.toml` (landing mode, merge policy, status map, evidence sources); `machine`/`user` stay local; Phase 2 splits the panel by scope | hot | M |
| **Secrets** | — (none today; the only pattern is worker bearer tokens stored as sha-256 **hashes**, `git-http.service.ts:12-37`, decision 012) | — | Jira API token + provider token per developer: **env vars / OS keychain, never `kanban.db`** — decision record in Phase 0 (§7 finding 2) | cold (new) | S |
| Identity | `schema/workers.ts`, `issue-comments.author` (role enum), `issue-activity.service.ts:33,43,58` (`"user"` hard-coded) | machine-shaped | Phase 3: `actor` on writes/comments (Jira accountId / git identity) — attribution, not access control | cold | M |
| Project binding | `project.service.ts` (0.843), `project-registration.ts` (`deduplicateProjects` by git root), `schema/projects.ts` (`repoPath` NOT NULL) | project ≡ one local path | `projects.remoteUrl`, `projects.trackerKey` (additive); dedup key `(remoteUrl, defaultBranch)` | hot | S–M |
| Cross-board claim | `auto-start-claim.ts`, `workspace-branch-create-claim.ts` (in-memory), `shared/lib/repo-lock.ts` (pid+hostname) | one-host exclusion | **`git push origin <sha>:refs/kanban/claims/<KEY>`** before workspace creation — ref creation is atomic per ref on the server, a second creator gets `[rejected]`. Jira Cloud REST v3 has **no conditional update** (no `If-Match`, no version CAS), so the assignee is a *projection* of the claim, not the claim. `monitor-cycle`/`monitor-auto-start` skip keys whose claim ref names another dev | cold (new) | M |

### S3 — Delivery

| Component | Files | Role today | Change | Class | Size |
|---|---|---|---|---|---|
| Landing | `merge-executor.service.ts` (single git core: dirty-main guard → backup → `mergeBranch` → ancestry check), `workspace-merge.service.ts` (0.846), `git-service/merge.ts:198,230` (**`reset --hard` of the checked-out main**) | local `--no-ff` merge | `landing = "local" \| "remote-pr"` — a **branch at the one `merge-executor` call site**, not a strategy port (§7 finding 4). `remote-pr`: push `kanban/<dev>/<PROJ-123>-<slug>`, open/refresh PR via GitHub REST, merge via API when a gate token exists; **never touches the local main checkout** | hot | M |
| Gate evidence | `server/src/services/merge-gate-evidence.ts` (SHA-pinned `MergeGateToken`; the module boundary exists so suites can mock `resolveMergeGate` — not a designed extension seam, but additive minting is still safe: `:57-64`), `pre-merge-gate.service.ts`, `workspace-merge-gate.ts` (3 h verdict age) | local `verify_script` 26–44 min + smoke; review is an agent | additive minters: `ci-status` (green **fast** CI on the same head/base SHA pair) and `pr-approval` (human review on the PR). Local suite becomes optional pre-push | cold | M |
| Exit workflow | `startup/exit-workflow.ts` (0.856; `handleBuilderSessionExit` CC 28; `handleReviewSessionExit` hosts the gate and calls `autoMerge` directly) | routes exit → review/gate/land | Phase 1: under `remote-pr` the builder exit pushes + opens the PR instead of arming a local merge; Phase 2: `introduce_event` — emit `work_ready`/`work_landed` with payload on `board-events`, drop direct calls | hot | M + L |
| Ancestry invariants | `ancestor-branch-reconciler.ts`, `done-unmerged-invariant-sweep.ts` (**auto-merges locally**, `MAX_AUTO_MERGES_PER_CYCLE=3`), `hand-merged-*`, `silently-merged-*`, `merge-train.service.ts:20-34` ("never squash, never rebase") | repair by "tip is ancestor of local main" | **Phase 0 decision: merge-commit PRs** (API merge passes `merge_method:"merge"` explicitly — GitHub can only *allow* methods per repo) → reconcilers compare to `origin/<base>`; the sweep **never auto-merges under `remote-pr`** | not in this snapshot's `refactor_first` | M |
| Merge drivers & tail | `startup/merge-workflow.ts` (`createAutoMerge` → `runMergeCore` :452; the **merge tail**: `cleanupMergedWorktreeAndBranch`, sibling cleanup, `mergedAt`, Done transition, `advanceLoopAfterMergedIssue`), `workspace-merge-execution.service.ts:69`, `workspace-repos.service.ts:620`, `startup/auto-merge-orchestrator.ts` (4th driver, `MERGEABLE_STATUS_NAMES=["In Review","AI Reviewed"]`, 30 s tick), `routes/workspace-actions.ts` (0.762) | three `runMergeCore` callers + one orchestrator; the consequences of a merge run synchronously after it | extract the tail as `finalizeLandedIssue(workspace, mergeSha)`; a `pr-landed` poller calls it when the PR's `merged_at` appears; every driver gets a `landing==="remote-pr"` guard | hot | L |
| Monitor cycle | `startup/monitor-cycle.ts` (0.822 → computed 4 seams) | polls, claims merge candidates | Phase 1: check Jira claim before acting; under `remote-pr` poll PR + checks. Phase 2: computed split | hot | S then L |
| Worker fleet | `agent-remote.service.ts`, `worker-*.service.ts`, `git-http.service.ts`, `worker-remote-sync.service.ts`, `shared/lib/worker-protocol.ts` | pull model; workers push only to `refs/kanban/incoming/*` | reusable as-is; the **board** pushes to origin after FF-sync — no origin credential on workers | cold | S |
| Event bus | `services/board-events.ts` (96 dependents, `{type, projectId, reason}`), `butler-event-feed.ts`, `outbound-webhook.service.ts` | reason-only invalidation | Phase 2: **payload-bearing event on the existing bus** (cheaper alternative the review asked for); a persisted outbox only if Phase 3 shows lost events | hot (3× `introduce_event`) | M |
| PR body | `github-handoff-draft.service.ts` (Markdown draft stored as artifact, never posted) | text only | PR description source in Phase 1 | cold | S |

## 4. Do-not-touch in this programme (hot, off-seam)

Real hotspots on no capability row — their path is `code-metrics remediation-plan`, not this
plan: `Layout.tsx` 0.885, `BoardToolbar.tsx` 0.879, `WorkspacePanel.tsx` 0.869, `ButlerView.tsx`
0.824 (76 fns), `IssueDetailPanel.tsx` 0.803, `DiffViewer.tsx` 0.783,
`workspace-summary.service.ts` 0.773, `BoardPage.tsx` (735 commits/180 d),
`backlog-markdown.service.ts` (CC 67). Housekeeping moved here from the phases: the `[tests]`
convention gap for shell tests. `server-start.ts` 0.908 is touched only to register flags.

## 5. Phases

Re-cut after review: the **first phase with a user-visible outcome is Phase 1** (two developers,
one Jira backlog, one remote, no double PR), built additively behind flags; the structural work
the metrics ask for comes in Phase 2, *against* known Jira/PR semantics rather than ahead of
them. Every exit criterion is re-measurable (§10); "done" = re-measured.

### Phase 0 — Decisions, secrets, safety net (no behaviour change)

Goal: the decisions Phase 1 cannot proceed without, as decision records; the existing fitness
machinery extended; the one schema change everything needs; a **behavioural** safety net over
every function Phase 1 touches.

- P0.1 **Decision record 0XX "team mode"**: supersedes the *scope* of decision 001 and the
  "not a step toward multi-tenancy" clause of 012; updates `docs/prd.md:5,222,271`,
  `our-positioning.md:72`, `CLAUDE.md` ("PR creation skipped"; and "`#N` never means a GitHub PR"
  becomes "…means a kanban issue; PRs are referenced as `PR #N`"). Fixes: (a) **merge-commit
  PRs** — API merge always passes `merge_method:"merge"`; provider setting disallows squash/rebase;
  (b) **secrets in env vars / OS keychain, never in `kanban.db`** (`AGENTIC_KANBAN_JIRA_TOKEN`,
  `AGENTIC_KANBAN_GH_TOKEN`) — for **both** the server and the MCP process; (c) **polling, not
  webhooks**; (d) **claims live on the remote** (`refs/kanban/claims/*`), Jira assignee is a
  projection; (e) `ai_reviewed` is a **workflow node with a local status**, projected to Jira as a
  custom field only if the Jira admin provides one — decides the `status_map` shape; (f) GitHub
  first, GitLab not scheduled. (S) — *exit criterion of this phase.*
- P0.2 `code-metrics baseline pin` on the starting commit. (S)
- P0.3 **Extend** `status-write-ratchet.test.ts` to cover direct `insert/update/delete(issues)`
  sites (start ≈ 32–34 / 21 files, tighten-only) and add two sibling ratchets: status-name
  literal files (start 107, incl. `MERGEABLE_STATUS_NAMES`) and MCP tools importing `../db`
  (start 80). (S)
- P0.4 `mcp-server → shared/schema` forbidden edge in `.dependency-cruiser.cjs` as **warn**
  (error in Phase 4); `.codemetricsrc [architecture]` mirrors it for measurement only —
  `pnpm check:arch` stays the gate of record. (S)
- P0.5 Split `source_key` out of `externalKey` (#201): additive column, backfill of
  `plugin-loop:*` values. (S)
- P0.6 **Safety net over the seven functions Phase 1 touches**: `handleBuilderSessionExit`,
  `handleReviewSessionExit` (`exit-workflow.ts`), `handleIdleWorkspace`,
  `handleReviewingWorkspace` (`monitor-cycle.ts`), `createAutoMerge` (`merge-workflow.ts`),
  the `auto-merge-orchestrator.ts` tick, the `done-unmerged-invariant-sweep.ts` auto-merge branch
  — characterisation tests where missing, **plus one recorded exit → review → gate → merge → tail
  trace with flags off**, replayed after every Phase 1 item. "Flags off = today" then has a check,
  not an assertion. (M)

Exit: decision record merged; ratchets green at their starting counts; depcruise warn rule
present; `externalKey` carries no `plugin-loop:*` values; the recorded trace replays green;
`scorecard` unchanged.

### Phase 1 — Two developers, one backlog, one remote (flagged, additive, reversible)

Goal: with `landing=remote-pr`, `tracker=jira`, `evidence=ci-status` in `.kanban/team.toml`, a
ticket goes Jira → claimed on origin → workspace → PR → fast CI green → merged via API →
**merge tail runs** (cleanup, `mergedAt`, Done, loop advance) → Jira transitioned, on two
laptops, with **no double workspace by construction**. Flags off = the recorded trace.

Order matters — the first item is what makes the rest additive instead of a branch inside CC-28
code (round-2 R8, integrated):

- P1.0 **Mechanical event extraction first.** Every `autoMerge(...)` / merge-tail site in
  `exit-workflow.ts`, `monitor-cycle.ts`, `merge-workflow.ts`, `auto-merge-orchestrator.ts`
  emits `work_ready {workspaceId, branch, headSha, baseSha, evidence}` on `board-events.ts`
  (payload added to the existing bus); the **default subscriber does exactly what the direct
  call did**. Extract the tail of `merge-workflow.ts` as `finalizeLandedIssue(workspace,
  mergeSha)` and have the default subscriber call it. The semantics of *where the fan-out is*
  are known today; only the payload is new. The P0.6 trace must replay green. (M)
- P1.1 `.kanban/team.toml` (checked in, in the **target** repo): `landing`, `tracker`,
  `evidence`, `status_map`, `jira.project`, `remote`. **Loader split from
  `settings-registry.ts`** (the registry is imported by client and mcp-server — 11 files — and
  cannot read a repo file in the browser); server-side loader, scope `team`, read-only in
  `SettingsPanel`. (S)
- P1.2 `remote-pr` = **a second `work_ready` subscriber**, not a branch: `git push origin
  dev/<dev>/<KEY>-<slug>` (prefix `dev/`, not `kanban/` — that is the fleet's incoming
  namespace), PR create/refresh via GitHub REST with `merge_method:"merge"`, body generated
  from `github-handoff-draft` (generate when no artifact exists), API merge when a
  `MergeGateToken` exists. A **`pr-landed` poller** (30 s, like the orchestrator) watches open
  board PRs; on `merged_at` it fetches and calls `finalizeLandedIssue` — loops, cleanup, Done
  and Jira all fire from the same tail as today; idempotent on `mergedAt` so a human merging on
  GitHub is handled too. All four merge drivers and the sweep carry a `landing==="remote-pr"`
  guard: **none of them touches the local main checkout** in that mode.
  `workflow-fork.service.ts:613` child → parent merges stay local (children never get PRs). (L)
- P1.3 Additive minters in `merge-gate-evidence.ts`: `ci-status` (checks green on the PR's
  head/base SHAs; **fast lane only** — lint + unit, target < 10 min; requires the *target* repo
  to have CI, §8) and `pr-approval`. Local `verify_script` optional pre-push under `remote-pr`. (M)
- P1.4 **Jira import, scoped**: `kanban tracker pull` + polling reconciler modelled on
  `workflow-node-divergence-reconciler.ts`. Rules under `tracker=jira`: import writes only
  issues whose `externalKey` matches and only when `syncedAt < jira.updated`; it **never
  overwrites the status of an issue with an open workspace** (board-owned while claimed); for
  issues with a `workflowTemplateId` the import sets the **node** via the `status_map` role and
  lets `statusId` derive (decision 005 honoured now, not in Phase 2); **local creation creates
  the Jira issue first or is refused** — plugin loops (`loop-unit-tickets.ts`, `skill-run.ts`),
  MCP create tools, CLI and UI all go through `createIssue`, which under `tracker=jira` calls
  Jira before inserting. (M)
- P1.5 Board → Jira via the `transitionIssueStatus` `onTransition` hook: **local write first,
  then enqueue** into `tracker_outbox` (one table: issueKey, transition, attempts, lastError);
  drained by the server every poll tick with retry; butler event after 3 failures. The MCP
  process either holds the token and drains its own rows or leaves them for the server — P0.1b
  decides; either way rows are never lost. `workspace-init.ts:88-90` routed through the hook. (M)
- P1.6 **Atomic claim**: before workspace creation `git push origin <sha>:refs/kanban/claims/<KEY>`
  (a commit whose message is `<dev> <iso-time>`); `[rejected]` = someone else owns it → skip.
  `monitor-cycle` and `monitor-auto-start` list `refs/kanban/claims/*` each cycle and skip
  foreign keys. Jira assignee set afterwards as a courtesy. Release = delete the ref on
  teardown / Done. (M)
- P1.7 Reconcilers under `remote-pr`: `ancestor-branch-reconciler`, `done-unmerged-invariant-sweep`
  compare to `origin/<base>` after `fetch`; the sweep's auto-merge branch is **disabled** in that
  mode (a Done-but-not-ancestor issue is reported, not merged). (S)
- P1.8 `projects.remoteUrl`/`trackerKey` additive; `deduplicateProjects` keys on
  `(remoteUrl, defaultBranch)` **only when the flag is on** (no backfill with flags off). (S)
- P1.9 Worker fleet: board pushes after `worker-remote-sync` FF; no worker-side origin token. (S)
- P1.10 **Kill-switch with drain**: `landing="local"` + `kanban landing drain` — fetch, list
  open board PRs, merge-or-close each, FF local main to `origin/<base>`, delete claim refs. Without
  the drain, flipping the flag leaves PRs whose landing is never detected and a local main behind
  origin that the reconcilers then act on. (S)

Exit criteria: **two-laptop test** (two `AGENTIC_KANBAN_DIR`s, one Jira sandbox or mock, one
bare remote + GitHub test repo, both boards polling the *same* Ready ticket) — exactly one claim
ref, one workspace, one PR; both tickets Done in Jira; the merge tail observed (worktree gone,
`mergedAt` set, loop advanced). With flags off: the P0.6 trace replays green **and** `compare
--history-ref <phase-1-start>` shows **no existing file's summed CC up by more than +2, the
`refactor_first` rank of the touched files not risen, and all new code in new files** (revision
2's "structure unchanged" was unattainable — new clients and a poller are new edges by
definition). `graph --dependents-of shared/schema/index.ts` unchanged; ratchets not regressed;
**CI budget observed** for one week (minutes/PR, PRs/dev/day → P3.5).

Risks: the biggest is now the **asynchronous merge tail** — a PR merged by a human on GitHub, or
a poller window missed, must still land in `finalizeLandedIssue`. Second: Jira workflow legality
— the Jira workflow wins, local `ISSUE_STATUS_TRANSITIONS` becomes advisory under `tracker=jira`;
an outbox row Jira rejects surfaces as a butler event, the local node stays. Third: polling rate
limits — per-project budget as in `monitor-project-scheduler.ts`.

### Phase 2 — Stabilise the seams the slice exposed (behaviour-preserving, now with known semantics)

Goal: the metrics' prescribed moves, applied to the files Phase 1 had to touch — so the second
tracker/provider-shaped change is not built into 0.8-risk files again.

- P2.1 `issue.service.ts` computed split (issueerror / issueid / statusname — three tickets);
  then a **Jira client module** (`server/services/tracker/jira-client.ts`) as the only writer to
  Jira; no local-adapter port. (L)
- P2.2 Semantic status roles (`ready/in_progress/review/ai_reviewed/done/cancelled`) resolved
  through `status_map`; `findStatus("In Review")` → `statusByRole`; literal ratchet shrinks
  toward 0 in server/shared/mcp. Decision 005 reconciled: **workflow node stays authoritative
  for behaviour; Jira status is the projection of the node's role** (minor finding). (M)
- P2.3 Finish the `introduce_event` P1.0 started: the remaining direct fan-out in
  `exit-workflow.ts` (cold-clone gate, learning step, butler, flaky radar) and `plugin-loop` /
  `workflow-fork` become subscribers of `work_ready` / `work_landed`; a persisted board-event
  outbox only if Phase 3 measures lost events (the `tracker_outbox` already exists for the Jira
  direction). (M)
- P2.4 `monitor-cycle.ts` computed 4-way split; the *verificationresult* group consumes tokens
  of any minter. (M)
- P2.5 MCP write tools (the six named in §3) → `board-call`; ratchet 80 → ≤ 74. (M)
- P2.6 Settings registry scopes (`machine | user | team`); `SettingsPanel` renders by scope
  (its own #1-hotspot fix), team keys read-only from `team.toml`. (M)

Exit criteria (`compare --history-ref <phase-2-start>` so the refactor's churn is frozen out):
`issue.service.ts`, `exit-workflow.ts`, `monitor-cycle.ts` out of `refactor_first` with
module-level summed CC / coupling flat or down (a line move fails); `introduce_event` no longer
prescribed for those three in `candidates`; literal ratchet ≤ 20 files; MCP ratchet ≤ 74; server ↔
shared leakage measured **with `--history-ref`** ≤ 0.4 (revision 1's 0.35 without freezing was
unattainable while adding columns — minor finding); all suites green.

### Phase 3 — Two-way sync & multi-instance hardening

- P3.1 Idempotent inbound sync: `(externalId, syncVersion)` upsert; two boards converge on the
  same Jira change; conflict rule **Jira wins on fields, board wins on the `kanban-claim` /
  ai-reviewed custom fields**. (M)
- P3.2 Actor attribution on writes and comments (`actor = {kind:"developer", id}`); Jira
  comments posted with the developer's token. (S)
- P3.3 Claim expiry (by `updated` age) and release on workspace teardown. (S)
- P3.4 Remaining MCP writers (repositories, shared engine) through the Jira client; MCP ratchet
  ≤ 40. (M)
- P3.5 **Two-tier gate**: fast CI mints evidence per PR (P1.3); the 30-min suite runs once in
  the provider's merge queue; local `merge-queue.service.ts` / `merge-train.service.ts` bypassed
  under `remote-pr` (documented, not deleted). Budget from Phase 1's measurement. (M)

Exit: two-board convergence test (same ticket edited in Jira and on one board); `[architecture]`
0 violations; `graph --dependents-of shared/schema/index.ts` unchanged since Phase 0.

### Phase 4 — Decommission & harden

- P4.1 Remaining MCP reads through server API; depcruise `mcp-server → shared/schema` rule
  warn → **error**; ratchet → 0. (L)
- P4.2 Under `tracker=jira` the local `issues` table is a cache (TTL) with the sync as its only
  writer; `outbound-webhook` removed in favour of bus subscribers. (M)
- P4.3 Retire path-based `deduplicateProjects`, "Combined Coupled Ticket Sources" description
  rewriting, `#N`-first copy. (S)
- P4.4 `scorecard` with **declared** targets and `analyze --fail-on-violations` in
  `arch-gate.yml`; `stakeholder-page` against the Phase-0 baseline. (S)

Exit: `compare <phase-0 baseline> <now> --history-ref <phase-0 sha>`: the seam hotspots out of
`refactor_first`, server ↔ shared leakage ≤ 0.3, `mcp-server` containment ≥ 50 % (from 24 %),
0 architecture violations; the team has run on it for two sprints.

## 6. Verification of the load-bearing facts (step 6a)

| # | Claim | Check | Verdict |
|---|---|---|---|
| 1 | MCP tools write SQLite directly | `grep -l "from \"../db"` in `mcp-server/src/tools`: 80 of 92; 23 use `board-call` | confirmed |
| 2 | ~340 status-name literals | by file: 107 non-test files (56/38/10/3) | weakened |
| 3 | `externalKey` overloaded by plugin-loop dedupe | `schema/issues.ts:22-30`, `plugin-keys.ts:25,37,44` | confirmed |
| 4 | Zero outbound git/PR/CI integration | no `octokit`/GitHub/GitLab API/`gh pr`; only `push` is worker → incoming ref | confirmed |
| 5 | `board-events` carries reason only | `board-events.ts:20,156` | confirmed |
| 6 | Landing `reset --hard`s the checked-out main; squash/rebase forbidden | `git-service/merge.ts:198,230`; `merge-train.service.ts:20,29,120` | confirmed |
| 7 | No user/actor entity | no `user*` schema; no `accountId/userId` | confirmed |

## 7. Adversarial review (step 6b) — two rounds, fresh generalist subagent each, rubric R1–R8

### Round 1 (on revision 1)

Verdicts on revision 1: R1 WEAK (stale numbers; items without a capability row) · R2 **FAIL**
(first team outcome in Phase 3) · R3 WEAK (ports with one implementation) · R4 **FAIL** (no
home for credentials; CI minutes unbudgeted; a CLAUDE.md "never" contradicted without a
decision) · R5 WEAK/PASS (existing ratchet and depcruise duplicated) · R6 WEAK (no cheaper
alternatives named) · R7 WEAK (biggest risk misnamed; `reset --hard` off the roadmap).

| # | Major finding | Fate | Where |
|---|---|---|---|
| 1 | Value arrives too late — first team outcome was Phase 3 behind 14 structural items | **integrated — phases re-cut** | §5: Phase 1 is now the two-developer slice; splits/events moved to Phase 2 |
| 2 | Credentials have no home; plan violates CLAUDE.md "local only, no OAuth" without proposing the decision | **integrated** | P0.1 decision record with secrets rule; S2 *Secrets* row; C4 amended |
| 3 | CI cost unbudgeted; 26–44 min gate × N devs × PR refreshes | **integrated + shortcoming** | P1.3 fast lane only, Phase-1 exit measures minutes, P3.5 two-tier gate; **who pays for CI is not decidable here** (§8) |
| 4 | Speculative ports: `LandingStrategy`, `IssueTrackerPort`+`LocalSqliteTracker`, `EvidenceSource`, provider port | **integrated** | landing = branch at one call site (P1.2); Jira-only client module (P2.1); additive minters, no interface (P1.3); GitHub only (P0.1e) |
| 5 | Existing `status-write-ratchet` and depcruise gate duplicated | **integrated** | P0.3 extends the ratchet; P0.4 adds a depcruise rule, `.codemetricsrc` measurement-only |
| 6 | `reset --hard` of main and ancestry-only invariants off the roadmap; merge method left as a late team decision | **integrated** | P0.1a merge-commit policy; P1.2 `remote-pr` never touches the checkout; P1.7 reconcilers read `origin/<base>` |
| 7 | Metric numbers drifted between snapshots; a "hidden dependency gone" exit criterion measured a withheld row | **integrated** | §2 refreshed from the 08-26 files; criterion replaced by the literal ratchet; provenance names the withheld rows |

Minor findings integrated: `merge-gate-evidence.ts` path and the reason for its boundary
(§3 S3); the swallowing try in `status-transition.ts:47-53` (P1.5); leakage criterion with
`--history-ref` (Phase 2); polling as decision (P0.1c); custom field instead of label (P0.1d);
decision 005 reconciled (P2.2); dedup key `(remoteUrl, defaultBranch)` (P1.8); `[tests]`
housekeeping moved to §4; MCP write tools named (§3).

**R8 comparison (round 1).** The reviewer's one-phase alternative (remote-pr flag + ci-status
minter + one-way Jira import + assignee claim + decision record) reached a two-developer outcome
before revision 1's Phase 2 — it became Phase 1. Phases 2–4 stay because that slice leaves
`issue.service.ts`/`exit-workflow.ts`/`monitor-cycle.ts` at 0.82–0.86 with new semantics on top.

### Round 2 (on revision 2 — hunting what the re-cut introduced)

Verdicts: R1 WEAK (two figures not in the snapshot; P1.2's real file set unlisted) · R2 PASS ·
R3 PASS · R4 WEAK (the hook runs inside the MCP process — a second credential home) · R5 WEAK
(import into `statusId` fights decision 005 in Phase 1, reconciled only in Phase 2) · R6 PASS ·
R7 **FAIL** (three load-bearing Phase-1 claims did not survive the code: "one call site",
"Jira update with expected version", "flags off = today" with a 2-of-7 safety net).

| # | Major finding | Fate | Where |
|---|---|---|---|
| 1 | `remote-pr` is not a branch at one call site — three `runMergeCore` callers + a fourth driver (`auto-merge-orchestrator`), and the **merge tail** (cleanup, `mergedAt`, Done, loop advance) has no trigger when the merge happens on GitHub; the sweep would then auto-merge locally | **integrated** | §3 *Merge drivers & tail*; P1.0 extracts `finalizeLandedIssue`; P1.2 `pr-landed` poller + guards in all drivers and the sweep; M → L; child→parent forks stay local |
| 2 | Jira claim is not atomic — Jira Cloud REST v3 has no conditional update; two boards polling the same ticket both win | **integrated** | claim moved to `refs/kanban/claims/<KEY>` (atomic ref creation on the remote); Jira assignee is a projection; P0.1d; the Jira-admin custom field leaves Phase 1's path |
| 3 | One-way import + hook is a **Phase 1** split-brain: local creation ungated, status flows both ways with no rule, `workspace-init` writes `statusId` outside the hook | **integrated** | P1.4 rules (scoped import, never overwrite while claimed, create-in-Jira-first, node-not-status per decision 005); P1.5 routes `workspace-init` |
| 4 | P0.6 covered 2 of the ≥ 7 functions Phase 1 edits; a `landing` branch inside CC-28 code before the split | **integrated — Phase 1 re-shaped** | P0.6 names all seven + a recorded trace; P1.0 mechanical event extraction *first*; `remote-pr` is a subscriber, not a branch |
| 5 | Hook failure semantics unspecified — before-write throws mid-`handleBuilderSessionExit`, after-write leaves Jira behind | **integrated** | P1.5: local write first, one-table `tracker_outbox` with retry — the outbox revision 2 deferred, but only for the tracker direction |
| 6 | Phase 1 exit "structure unchanged" fails by construction (new clients, poller, loader are new edges) | **integrated** | exit rewritten: no existing file +2 summed CC, ranks not risen, new code in new files |
| 7 | Kill-switch has no drain semantics | **integrated** | P1.10 `kanban landing drain` |

Minors integrated: settings loader split from the registry (11 client/mcp importers); no
`remoteUrl` backfill with flags off; target-repo CI assumption (§8); `dev/` branch prefix;
handoff draft generated when absent; `MERGEABLE_STATUS_NAMES` in the literal ratchet;
`merge_method:"merge"` explicit; CLAUDE.md `#N` note; `ai_reviewed` decision moved to P0.1e;
provenance counts corrected.

**R8 comparison (round 2):** same phase, different coordination substrate — origin as the atomic
store, event extraction before the branch, the tail via a poller. Adopted almost verbatim as
P1.0 / P1.2 / P1.6. No third round was run; one is warranted only if Phase 1 is re-shaped again.

## 8. Known shortcomings

- **CI budget owner.** The plan can shape the gate (fast lane per PR, full suite in the merge
  queue) but cannot decide who pays for CI minutes or what the ceiling is. Owner: whoever runs
  the team's GitHub org. Input: Phase 1's one-week measurement.
- **Jira sandbox.** Phase 1's exit needs a Jira project the team can write to (or a mock that
  reproduces transitions and `updated` timestamps — custom fields and versioned updates are no
  longer required in Phase 1). Owner: the team's Jira admin.
- **Target-repo CI.** `ci-status` evidence assumes the repo being developed has a fast CI lane;
  `arch-gate.yml` is the board's own. Owner: the team using the board, per repo.
- **Second credential home.** `transitionIssueStatus` runs inside the MCP process; if that
  process is to drain its own outbox rows it needs the Jira token too. The plan offers both
  shapes (P1.5); the decision record must pick one. Owner: the developer team.
- **Positioning.** The product's own PRD and positioning declare this goal a non-goal. P0.1
  writes the decision; it cannot make it. Owner: the product owner.
- **`--module-crime` hidden-dependency rows are withheld** for the two pairs that matter most
  (client ↔ server, mcp-server ↔ server) because 5 server imports do not resolve. The engine, not
  this plan, has to fix that before the metric can serve as an exit criterion.

## 9. Open decisions for the team

Reduced by P0.1 to: (1) the `status_map` per project; (2) whether the `ai_reviewed` node should
be projected to Jira at all (custom field) or stay board-local; (3) whether the board-event
direction also needs a persisted outbox after Phase 3 measures lost events (the tracker
direction has one from Phase 1).

## 10. How to re-measure

```
CM=<code-metrics-skill>/code-metrics/.venv/Scripts/code-metrics.exe
$CM baseline pin <repo> --label team-capable-phase0                 # Phase 0
$CM analyze <repo> -o <out> --days 180 --history-ref <phase-start-sha>
$CM compare <baseline-analysis.json> <out>/analysis.json            # structure only moves
$CM query <out>/analysis.json --class refactor_first --top 30       # seam files gone?
$CM candidates <out>/analysis.json                                  # introduce_event still prescribed?
$CM refactor <out>/analysis.json --boundaries                       # server↔shared leakage (frozen history)
$CM query <out>/analysis.json --tangle                              # containment
$CM graph <out>/analysis.json --dependents-of shared/src/schema/index.ts
pnpm check:arch                                                     # depcruise + god-module gate of record
$CM stakeholder-page <baseline> <out>/analysis.json                 # before/after for the team
```
