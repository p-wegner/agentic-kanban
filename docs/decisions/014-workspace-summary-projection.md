# 014 — Workspace summary as an event-updated projection (refs #399)

## Status
Accepted, 2026-08-11. Part of the 2026-08-11 performance-review series (#398 git-spawn
scheduler, #401 async tail reads landed first).

## Problem — the 8-phase recompute
`buildWorkspaceSummaryMap` (`packages/server/src/services/workspace-summary.service.ts`)
assembles the per-issue `workspaceSummary` in 8 phases: (1) count aggregation, (2) showdown
metadata, (3) main-workspace selection, (4) **git prefetch** — `git log -1` +
`git rev-list --count` per active workspace, (5) diff-stat / code-metrics / conflict
attachment, (6) workflow info, (7+8) latest-session lookup + transcript tail reads. Phases
1–3, 6 and the row-served parts of 5 are cheap SQL (~7 queries, all `IN`-batched). The
expensive parts were:

- **Phase 4 git spawns**: 2 subprocesses per active workspace, held only in an in-memory
  30s SWR map (`gitOpsCache`) that died on every tsx-watch restart — so every server
  restart re-paid 2×N spawns, and a true first sighting paid them **inline** (blocking the
  build, and with it `/board`, `/graph`, and `GET /api/projects/all/workspaces`).
- Phase 7+8 transcript tails — already bounded+async since #401.
- Phase 5 diff/conflict probes — already **persisted** per-workspace
  (`diff_stat_cache_*`, `conflict_cache_*` columns) and refreshed via `runBgGit`.

With 23 projects / 571 workspaces a cold rebuild was seconds of spawn+I/O that starved the
event loop (measured `/api/health` 6–24s).

## Decision — persist the git facts on the workspace row, mark dirty on board events

The summary decomposes naturally onto the `workspaces` table: everything except the phase-4
git facts is either already a row column or cheap SQL. So the projection is **not a new
table** — it is five new columns on `workspaces` (migration 0114), the same pattern the
diff-stat and conflict caches already use:

| column | holds |
|---|---|
| `summary_head_sha` | short SHA from `git log -1` |
| `summary_head_message` | subject line from `git log -1` |
| `summary_commit_count` | `git rev-list --count base..HEAD` |
| `summary_git_refreshed_at` | staleness stamp (per-row) |
| `summary_dirty` | board-event / external-mutation marker (default 1 so pre-0114 rows heal on first sight) |

**Read path (hot):** phase 4 becomes a pure projection read — zero git spawns, zero
awaits. A row whose projection is *fresh* (not dirty, `summary_git_refreshed_at` within
TTL — 30s for active-status workspaces, 5 min for idle/blocked/etc., since an idle
worktree's HEAD only moves through board services, which mark dirty) is served as-is. A
stale/dirty row is **still served from the projection** (last-known values, SWR) while a
background refresh (`runBgGit` lane, deduped per workspace) re-runs the two git ops and
writes through — including chaining a diff-stat refresh when the HEAD SHA advanced, which
preserves the old "HEAD moved → diff refresh" trigger that used to ride on the inline
prefetch.

**Incremental writers (events that change the summary):**
- `setWorkspaceStatus` (`@agentic-kanban/shared/lib/workspace-status`) — the single
  status-transition authority — stamps `summary_dirty = 1` atomically with every status
  write. This one choke point covers session start (→ active), session exit (→ idle /
  reviewing / error), review/fix transitions, merge close, and monitor actions, because
  the status-write ratchet test forbids raw status writers.
- `stampWorkspaceMergedAt` (merge execution repository) marks dirty when a merge lands.
- `updateBase` (rebase/merge-base) marks dirty after rewriting worktree history.
- The background diff-stat refresh already writes through to the row (pre-existing).

**Drift healing (external git mutations):** a commit made by hand in a worktree changes
HEAD without any board event. Two healers, no new timers:
1. The per-status TTL above — an *active* workspace (agent running, commits happening)
   refreshes on the same 30s SWR cadence as before.
2. A reconcile pass `healWorkspaceSummaryProjection` piggybacks the existing **5-minute
   resource-sweep interval** in `monitor-setup.ts`: it picks a bounded batch (8) of the
   dirtiest rows (dirty first, then oldest `summary_git_refreshed_at`), re-runs the same
   git ops the full builder would, and writes through — so drift heals even when nobody
   is reading the board. `buildWorkspaceSummaryMap` itself remains the full-rebuild
   fallback and produces identical output either way.

## Projection boundary — what stays lazy (deliberate cut)
Per the ticket's escape hatch, three sub-signals are **not** event-projected and keep
their existing lazy/SWR machinery, because each already persists on the row and its
recompute is either expensive or meaningless to trigger eventfully:
- **Conflict detection** (`conflict_cache_*`, 5-min SWR): conflicts appear when the *base*
  moves, an event the workspace row does not observe; the read-triggered SWR probe is the
  honest owner.
- **Diff stats** (`diff_stat_cache_*`, 30s SWR + head-advance chain): already persisted;
  only the trigger moved (now chained off the projection refresh instead of the inline
  prefetch).
- **Transcript tails / session fields** (phase 7+8): file I/O, not git; bounded and async
  since #341/#401; the freshest value genuinely lives in the `.out` file.

The zero-git-spawn acceptance test reflects this boundary honestly: it seeds fresh
projection + fresh diff/conflict/code-metrics caches and asserts zero calls through the
git-exec seam on the hot path.

## Rejected alternatives
- **Separate `workspace_summaries` table** — pure overhead: every projected fact is
  1:1 with a workspace row, and joins/upkeep (cascade deletes, mirror rules) would
  duplicate what the row already provides. The existing diff/conflict cache columns set
  the precedent.
- **Full event-sourced projection incl. counts/sessions/workflow** — those phases are
  already single-digit-millisecond batched SQL; projecting them adds invalidation bugs
  and saves nothing measurable.
- **Filesystem watchers on worktree `.git/HEAD` for perfect external-drift detection** —
  hundreds of watchers on Windows for a signal the 30s/5-min SWR + heal pass already
  bounds; fragility not worth it.
- **Dropping the in-memory summary-map cache** — kept unchanged: it still coalesces
  whole-map assembly (counts/sessions/workflow SQL), while the projection removes the
  git cost underneath it. Supply-side change only; the board payload is unchanged.
