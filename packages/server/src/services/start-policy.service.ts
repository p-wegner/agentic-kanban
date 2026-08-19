import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import type { StartPolicy } from "@agentic-kanban/shared/types";
import { resolveMonitorTunables } from "./strategy-objective.service.js";
import { getBool } from "@agentic-kanban/shared/lib/settings-registry";
import { START_MODE_VALUES } from "@agentic-kanban/shared/lib/dynamic-preference-keys";

/**
 * Start Mode — the single per-project decision for HOW new tickets get auto-started.
 *
 * This is the source of truth that every auto-start code path consults, replacing the
 * scattered OR of `auto_monitor` / `board_autodrive_<id>` / `nudge_auto_start` /
 * `dependency_auto_chain` / `backlog_empty_strategy`. Before this, those flags were checked
 * independently, so turning a project's drive OFF did not stop the post-merge dependency
 * cascade (it had its own gate) — a project could keep auto-starting tickets with every
 * "drive" switch off. The mode is now the kill-switch; the finer prefs remain the enable
 * signal, ANDed in, so `monitor` projects keep their prior behavior and `manual` is a true
 * stop.
 *
 *  - `manual`    — nothing auto-starts. Only explicit user/agent actions (POST /api/workspaces,
 *                  relaunch) create workspaces.
 *  - `monitor`   — the in-process deterministic monitor auto-starts unblocked backlog/todo
 *                  tickets up to the WIP target; post-merge cascade and backlog refill follow
 *                  their own opt-in prefs.
 *  - `conductor` — the out-of-process board-monitor loop (`scripts/board-monitor/loop.sh`) is
 *                  the SOLE driver (via the ungated POST path). The in-process monitor stands
 *                  down so the two never double-start. Independent scheduled crons still fire.
 */
export type StartMode = (typeof START_MODE_VALUES)[number];


// The response shape lives in shared (#567) — the client had its own drifted copy that
// was missing `postMergeFollowups`. Re-exported here because that is where the server
// already imports it from.
export type { StartPolicy };

// #496: built from the registry, so an unregistered prefix is a COMPILE error.
const startModePrefDef = projectPref("start_mode");
const autodrivePrefDef = projectPref("board_autodrive");

export function startModePrefKey(projectId: string): string {
  return startModePrefDef.key(projectId);
}

// Derived from the shared START_MODE_VALUES list so preference writers (settings
// route, MCP set_preference) validate against exactly what this resolver accepts.
const VALID_MODES: ReadonlySet<string> = new Set<StartMode>(START_MODE_VALUES);

/**
 * Resolve the effective Start Mode + capabilities for a project. Mirrors
 * `resolveMonitorTunables` (explicit pref wins; legacy prefs derive a fallback) and carries a
 * `source` so the UI can show provenance.
 *
 * Per-project Start Mode is authoritative: when `start_mode_<id>` is set it fully supersedes
 * the global `auto_monitor` toggle. The global flag only participates in DERIVING a mode for a
 * project that has not set one yet (back-compat — nothing breaks before anyone re-saves).
 */
export function resolveStartPolicy(prefMap: Map<string, string>, projectId: string): StartPolicy {
  const explicit = prefMap.get(startModePrefKey(projectId));
  const mode: StartMode = VALID_MODES.has(explicit ?? "")
    ? (explicit as StartMode)
    : deriveMode(prefMap, projectId);
  const source: StartPolicy["source"] = VALID_MODES.has(explicit ?? "") ? "start_mode" : "derived";

  const wip = resolveMonitorTunables(prefMap, projectId).tunables;
  const cascadeOptIn = getBool(prefMap, "dependency_auto_chain");
  const followupOptIn = getBool(prefMap, "auto_start_followup");
  const refillOptIn = prefMap.get("backlog_empty_strategy") === "generate_tickets";

  switch (mode) {
    case "monitor":
      return {
        mode, source, wip,
        autoStartUnblocked: true,
        postMergeCascade: cascadeOptIn,
        postMergeFollowups: followupOptIn,
        backlogRefill: refillOptIn,
        scheduledRuns: true,
      };
    case "conductor":
      // The external loop owns starts; keep all in-process auto-start OFF to avoid
      // double-driving. Scheduled crons are independent and still honored.
      return {
        mode, source, wip,
        autoStartUnblocked: false,
        postMergeCascade: false,
        postMergeFollowups: false,
        backlogRefill: false,
        scheduledRuns: true,
      };
    case "manual":
    default:
      return {
        mode: "manual", source, wip,
        autoStartUnblocked: false,
        postMergeCascade: false,
        postMergeFollowups: false,
        backlogRefill: false,
        scheduledRuns: false,
      };
  }
}

/**
 * Derive a mode from legacy prefs for a project with no explicit `start_mode_<id>`.
 * `conductor` is never derived — it is only ever set explicitly (the dogfood board).
 */
function deriveMode(prefMap: Map<string, string>, projectId: string): StartMode {
  const autodrive = prefMap.get(`board_autodrive_${projectId}`) === "true";
  const globalMonitorAutoStart =
    getBool(prefMap, "auto_monitor") && getBool(prefMap, "nudge_auto_start");
  return autodrive || globalMonitorAutoStart ? "monitor" : "manual";
}

/**
 * #595 — moved here from `startup/monitor-setup.ts`. Both are pure prefMap resolvers over
 * `resolveStartPolicy`, so this file already owned the decision they wrap; they only lived
 * in `startup/` because the monitor was their loudest caller. Keeping them there forced
 * `routes/internal-monitor.ts` to import a startup module for one function, which is a
 * `no-circular` violation the moment those routes leave `startup/`'s rule-free zone.
 */
/**
 * Project ids whose *resolved* Start Mode is `monitor` — i.e. the in-process deterministic
 * monitor is their driver. This routes through `resolveStartPolicy` (the single source of truth,
 * decision 008) instead of reading `board_autodrive_*` raw, so it honours both an explicit
 * `start_mode_<id>` AND the legacy-flag derivation, fixing two scheduling bugs:
 *   (a) `start_mode=monitor` with autodrive unset & `auto_monitor` off (force-disabled every boot)
 *       — previously never scheduled because the gate was purely `auto_monitor || board_autodrive`.
 *   (b) `start_mode=manual` with a stale `board_autodrive=true` — no longer counts as driven, so
 *       `manual` is a real kill-switch (the old regex would still schedule/act on it).
 * `conductor` is intentionally NOT included: the external loop drives it and the in-process engine
 * stands down. Candidate ids are gathered from both key families so any project that ever set a
 * mode or a legacy flag is considered.
 */
export function monitorDrivenProjectIds(prefMap: Map<string, string>): Set<string> {
  const candidates = new Set<string>();
  for (const key of prefMap.keys()) {
    const sm = startModePrefDef.projectIdOf(key);
    if (sm) candidates.add(sm);
    const ad = autodrivePrefDef.projectIdOf(key);
    if (ad) candidates.add(ad);
  }
  const ids = new Set<string>();
  for (const projectId of candidates) {
    if (resolveStartPolicy(prefMap, projectId).mode === "monitor") ids.add(projectId);
  }
  return ids;
}

/**
 * The monitor cycle should run/reschedule when the global toggle is on OR any project resolves to
 * `monitor` Start Mode. Start Mode (via `resolveStartPolicy`) — NOT the raw `board_autodrive` flag —
 * is now the authoritative scheduling input, so a `monitor` project schedules even with autodrive
 * unset, and a `manual` project with a stale autodrive flag does not.
 */
export function monitorShouldRun(prefMap: Map<string, string>): boolean {
  return getBool(prefMap, "auto_monitor") || monitorDrivenProjectIds(prefMap).size > 0;
}
