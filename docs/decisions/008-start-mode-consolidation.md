# Decision 008: One per-project Start Mode for all ticket auto-start

## Date: 2026-06-14

## Context
"How does a new ticket get auto-started?" had grown into an **OR across ~8 independent code paths**,
each gated by its own preference with no single source of truth:

| Path | Old gate |
|---|---|
| In-process monitor auto-start (`runAutoStart`) | `auto_monitor` OR `board_autodrive_<id>`, plus `nudge_auto_start` |
| Post-merge dependency cascade (`autoStartUnblockedDependencyIssue`) | `dependency_auto_chain` |
| Backlog-empty refill (`runBacklogEmptyStrategy`) | `backlog_empty_strategy` |
| Scheduled (cron) runs | DB `enabled` |
| Out-of-process Conductor loop (`scripts/board-monitor/loop.sh`) | running process (no board pref at all) |
| Manual `POST /api/workspaces` / relaunch | — (intentional) |

This was not just untidy — it was **incorrect**. Turning a project's drive OFF
(`board_autodrive=false`) did **not** stop auto-starts, because the post-merge cascade had its own
gate that no "drive" switch touched. A real incident: a board kept auto-starting tickets with
`auto_monitor=false`, every `board_autodrive_*=false`, and `dependency_auto_chain=false` — only
killing `auto_merge` (starving the merge events the cascade rides on) stopped it. And the external
Conductor loop was governed by nothing in the board at all.

## Decision
Introduce a **single per-project Start Mode** — `start_mode_<projectId>` ∈ `manual | monitor |
conductor` — resolved by `resolveStartPolicy(prefMap, projectId)` (`start-policy.service.ts`,
mirroring `resolveMonitorTunables`). It is the ONE decision every auto-start path consults.

- **`manual`** — nothing auto-starts (a true kill-switch, incl. the post-merge cascade).
- **`monitor`** — in-process deterministic engine auto-starts unblocked backlog up to WIP; the
  cascade and backlog-refill follow their existing opt-in prefs (ANDed under the mode).
- **`conductor`** — the out-of-process loop is the sole driver; in-process stands down (no
  double-start). Scheduled crons still honored. Agentic-kanban only.

The mode is the kill-switch; the finer prefs (`dependency_auto_chain`, `backlog_empty_strategy`)
remain the *enable* signal. **Back-compat**: when `start_mode_<id>` is unset, the mode is DERIVED
from the legacy flags (`board_autodrive` OR `auto_monitor`+`nudge_auto_start` ⇒ `monitor`, else
`manual`) with a `source: "start_mode"|"derived"` provenance — nothing breaks pre-migration.
`setDriveEnabled` (the #806 one-switch) writes `start_mode` (on=monitor/off=manual) so they never
drift. **Per-project Start Mode supersedes the global `auto_monitor`.**

The **Conductor loop is now first-class under this control**: `conductor-control.service.ts` +
`POST /api/projects/:id/conductor {action}` let the Monitor-view Start Mode selector start/stop the
external loop. Stop tree-kills *every* `loop.sh` process (not just the recorded PID) so repeated
start/stop can't orphan an earlier loop.

## Consequences
- One understandable control in the Monitor view (3-mode selector + sub-toggles + a live "what
  starts a ticket now" read-out), replacing scattered toggles across Settings.
- The incident class (a drive that won't turn off) is fixed by construction — `manual` gates all
  in-process paths *and* stops the external loop.
- No migration (pure pref). Existing autodrive/monitor projects keep working via derivation.
- Caveat carried over from 006: Conductor liveness in the UI is `loop.log`-freshness based
  (`readOrchestratorStatus`, 11-min window), not a process check — so it shows "running" and
  refuses a restart for ~11 min after a stop. A hard stop should scan for the `loop.sh` process.

Builds on decisions 003 (Butler), 006 (board-monitor orchestrator) and the #806 Drive one-switch.
Commits: `e5d73d5d` (consolidation), `c18f2688` (Conductor in the UI), `5817e460` (stop reaps all loops).
