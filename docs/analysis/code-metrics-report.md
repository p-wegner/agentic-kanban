# Code Metrics Report — agentic-kanban

**Ticket:** #670 — Architecture Improvement (code-metrics): run code-metrics
**Tool run:** `code-metrics analyze` (fast mode — external toolchains like rubocop/reek/CK
skipped; every always-on signal, incl. all complexity/coupling/layer/schema/dependency
channels, ran) against this worktree, `--config`/`.codemetricsrc` as committed in the repo.
**Scope:** 2,590 files scanned, 350,084 SLOC (203,787 production / 146,297 test, 42% test).
Raw output: `code-metrics-out/` (gitignored — not committed; regenerate with
`code-metrics analyze <repo> --fast`).

This is a point-in-time snapshot, not a before/after comparison (no frozen history anchor
was used — see the tool's Stage 0⅛ caveat). Every finding below was checked against the
cited file/line before being recorded.

## Executive summary

| Metric | Value |
|---|---|
| Refactor-first candidates (production) | 244 of 1,529 production files |
| Knowledge-transfer risks | 80 |
| Dedup candidates | 31 |
| Logic in adapters (frontend/controllers) | 48% (centre of gravity 0.335 toward adapters) |
| Layer violations | 193 (154 persistence-query-in-adapter, 39 template-reaching-into-persistence) |
| Module clusters found vs. configured | 19 natural clusters (modularity 0.702, entanglement 0.06) vs. 6 configured modules |
| Prescribed refactoring moves | 163 (1 break-cycle, 94 split-responsibility, 58 introduce-event, 1 introduce-facade, 4 extract-shared, 5 relocate-file) |
| Runtime/framework EOL | Node `>=20.11`, end-of-support 2026-04-30 — **0.3 years past support** |
| Rework rate (📛 see caveat below) | 93.2% of 1,113 changes — **not usable as a defect signal on this repo**, see "Signals that do not apply here" |

## Top refactor-first files (verified)

| # | File | Risk | Max CC | Churn 90d | Notes |
|---|---|---|---|---|---|
| 1 | `packages/server/src/server-start.ts` | 0.841 | 25 | 267 | Single function `startServer` (`server-start.ts:60`) carries CC 25 across 118 NLOC in a 322-line/199-SLOC file — verified: the function body inlines loop-lag monitor setup, session-restore, WS wiring and shutdown-handler registration in one block. |
| 2 | `packages/server/src/services/plugin.service.ts` | 0.826 | 30 | 41 | 93% single-author, 19 days old — new code already carrying high complexity. |
| 3 | `packages/server/src/services/workspace-merge.service.ts` | 0.821 | 30 | 112 | |
| 4 | `packages/client/src/components/IssueDetailPanel.tsx` | 0.799 | 19 | 211 | |
| 5 | `packages/server/src/services/plugin-loop.service.ts` | 0.795 | 33 | 30 | |
| 6 | `packages/server/src/startup/monitor-cycle.ts` | 0.795 | 41 | 48 | Highest max-CC in the top-10 (41). |
| 7 | `packages/server/src/startup/exit-workflow.ts` | 0.787 | 31 | 83 | Also flagged for a 10-way cross-module fan-out (see "Prescribed moves" below). |
| 8 | `packages/client/src/components/ButlerView.tsx` | 0.787 | 26 | 67 | Also has 4 layer-fit violations (persistence query mixed into a view component). |
| 9 | `packages/server/src/services/issue.service.ts` | 0.774 | 30 | 69 | |
| 10 | `packages/server/src/routes/workspaces.ts` | 0.761 | 15 | 105 | |

Full ranked list (244 files): `code-metrics query analysis.json --class refactor_first --top 244`.

## Where business logic is misplaced (layer fit)

48% of decision points sit in the adapter layers (frontend/controllers) rather than the
domain/service layers. By module, `client` has a centre-of-gravity of 0.000 (all its own
logic is adapter-layer by construction — expected for a UI package) but the violation count
matters more than the ratio: **193 layer violations**, dominated by:

- **154× persistence query built in an adapter** — worst offenders (verified against
  `code-metrics-out/report.md`):
  - `packages/client/src/lib/agent-output-parser.ts` — 9 violations (5 query-in-adapter, 4 model-in-view)
  - `packages/client/src/lib/fleetLiveStats.ts` — 9 violations
  - `packages/client/src/lib/context-window.ts` — 9 violations (all query-in-adapter)
  - `packages/client/src/lib/viewRegistry.tsx` — 7 violations
  - `packages/server/src/routes/issue-export-import.ts` — 6 violations (server-side controller, not client)
- **39× template reaching into persistence.**

Note: "query-in-adapter" here is the client's own model/store reads flagged by the same
pattern as a server-side ORM query — for a React client this class of finding is best read
as "state/derived-data logic living in a `lib/` helper instead of a store/selector", not a
literal SQL-in-template issue. Worth a follow-up ticket to confirm signal quality for the
frontend before acting on the full list.

## Prescribed refactoring moves (top, by priority)

163 moves were computed from the coupling graph (`code-metrics refactor`). Highlights:

- **Break cycle** — a module-level dependency cycle between `root` and `server` (the
  unassigned top-level/composition-root files and the `server` module import each other).
- **Split responsibility** (94 instances) — god/bridge files whose functions cluster into
  distinct cohesive groups:
  - `packages/shared/src/lib/git-exec.ts` (25 functions) → 3 seams: git ops, result-memoization, buffered-spawn.
  - `packages/shared/src/lib/plugin-manifest.ts` (29 functions) → 3 seams.
  - `packages/server/src/repositories/issue.repository.ts` (31 functions) → 3 seams: project/status queries, issue-id lookups, touched-files JSON.
- **Introduce event** (58 instances) — files with high cross-module fan-out that could
  publish a domain event instead of calling collaborators directly:
  - `packages/server/src/services/workspace-provision.service.ts` (10 cross-module calls)
  - `packages/server/src/startup/exit-workflow.ts` (10 cross-module calls)
  - `packages/server/src/tools/get-board-status.ts` (9)
  - `packages/server/src/services/pre-merge-gate.service.ts` (9)
- **Introduce facade** — `shared` module has 91 internal entry points reached by 738
  external callers; a published facade would shrink the blast radius of any internal change.

Full list with edge-level evidence: `code-metrics-out/structure.md` § "Refactoring
Opportunities".

## Structure / bounded contexts

Louvain clustering (auto-resolution 0.5) finds **19 natural clusters** with modularity 0.702
and entanglement 0.06 — a well-separated import/co-change graph overall, but this is computed
against the file-level coupling graph, not the 6 module boundaries declared in
`.codemetricsrc` (`client`, `server`, `shared`, `mcp-server`, `e2e`, `desktop`). The gap
between 19 natural clusters and 6 declared modules suggests some of the declared modules
(particularly `server`, 637 files) bundle several cohesive sub-clusters that aren't
individually named — consistent with the god-file/split-responsibility findings above.

## Dependency health

- 10 dependencies tracked; 1 upgrade blocker.
- **Node runtime (`>=20.11`) is past its declared end-of-support** (2026-04-30, ~0.3 years
  past as of this run) — the only EOL/security-posture finding this run surfaced. No forks,
  shims, or removed-API call sites detected.

## Signals that do not apply here (recorded so they aren't re-mined)

- **Rework rate (93.2%)** — the tool's "share of changes that came back as a fix within 14
  days" heuristic detects it from `fix:`-prefixed commit subjects. **Spot-checked against
  actual history** (`git log -- packages/client/src/routes/BoardPage.tsx`): commits like
  `fix(#390): make the board-level butler reachable and plugin-aware, and give onboarding
  real tools` and `fix(#446): put the workspace panel in the URL and make an inbox click open
  its ticket` are feature/ticket work, not defect corrections — this repo's convention
  prefixes every commit with a conventional-commit type (`fix`/`feat`/`refactor`/`perf`) tied
  to a kanban ticket, not to whether the change was a bug fix. The 93.2% figure is a
  commit-convention artifact, not a defect-rework signal, and should not be quoted as one.
- **Query shape (0 risk sites)**, **side effects (0 callbacks)** — genuinely clean by this
  scan; this is a Drizzle/TS backend, not an ActiveRecord-style ORM the query-shape detector
  targets, so a 0 here reflects the detector's coverage more than a verified absence of N+1s.
- **Defects / activation / surface / runtime-shape / coverage** — no defect register, feature-flag
  export, OpenAPI contract, perf report, or coverage report is configured, so these blocks
  are `unavailable`/`unknown` by design, not zero.

## Test-detection gap

`analyze` flagged: Shell scripts (0 of 7 matched the test convention) include
`docker/entrypoint.test.sh`, which looks test-like but is not classified as a test file.
Low-impact (7 files) — not acted on here; note left for whoever next tunes
`.codemetricsrc`.

## Recommended next steps (not actioned by this ticket — analysis only)

1. File a ticket to split `packages/server/src/server-start.ts`'s `startServer` (line 60,
   CC 25) into its constituent phases (loop-lag monitor, session restore, WS wiring,
   shutdown handlers) — each is already a distinct concern per the split-responsibility
   evidence.
2. File a ticket to break the `root ↔ server` module cycle — likely a composition-root file
   under `packages/server/src/` importing back from something `server` depends on; needs the
   edge-level detail in `structure.md` to name the exact pair.
3. Investigate whether `packages/server` (637 files, 111 refactor-first, avg risk 0.406)
   should be re-cut along the 19 natural clusters this run found, rather than treated as one
   module — would sharpen both future `code-metrics` runs and the dependency-cruiser layering
   rules already in place.
4. Do not act on the 93.2% "rework rate" without first re-deriving it with a real
   bug-vs-feature signal (e.g. a `bug` kanban tag) — the current commit-message heuristic is
   confirmed unreliable for this repo's conventional-commit-per-ticket convention.
