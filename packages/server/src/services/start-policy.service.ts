import { resolveMonitorTunables, type MonitorTunables } from "./strategy-objective.service.js";
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

export interface StartPolicy {
  mode: StartMode;
  /** The in-process monitor may auto-start unblocked backlog/todo tickets. */
  autoStartUnblocked: boolean;
  /** The post-merge dependency cascade may start the next unblocked ticket. */
  postMergeCascade: boolean;
  /** The backlog-empty refill skill may run to generate tickets. */
  backlogRefill: boolean;
  /** Cron/HTTP scheduled runs are honored. */
  scheduledRuns: boolean;
  /** Effective WIP/refill tunables (from the Strategy Bullseye, else legacy prefs). */
  wip: MonitorTunables;
  /** Whether the mode came from an explicit per-project `start_mode_<id>` or was derived. */
  source: "start_mode" | "derived";
}

export function startModePrefKey(projectId: string): string {
  return `start_mode_${projectId}`;
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
  const refillOptIn = prefMap.get("backlog_empty_strategy") === "generate_tickets";

  switch (mode) {
    case "monitor":
      return {
        mode, source, wip,
        autoStartUnblocked: true,
        postMergeCascade: cascadeOptIn,
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
        backlogRefill: false,
        scheduledRuns: true,
      };
    case "manual":
    default:
      return {
        mode: "manual", source, wip,
        autoStartUnblocked: false,
        postMergeCascade: false,
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
