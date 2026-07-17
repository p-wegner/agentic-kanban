/**
 * Orphaned per-workspace Docker service-stack reaper (#52).
 *
 * A workspace's Compose stack (`ak-<instanceId>-ws-<workspaceId>`) is downed on
 * merge/close/delete — but several runtime paths deliberately SKIP the down and cite
 * "the startup reaper reclaims true orphans" as their backstop (a failed/skipped down
 * after a docker hiccup, the compensating down after a failed `up --wait`). That
 * backstop used to run EXACTLY ONCE, at boot — so on a board designed to run for days
 * under autodrive, a leaked postgres + volume stayed leaked for the life of the
 * process. This module runs the same reap PERIODICALLY, and makes it status-aware so
 * it can also reclaim a leaked stack whose OPEN workspace is stuck at status "error".
 *
 * Two callers, one engine, ONE difference — how a workspace with NO parsed stack
 * state is treated (`shieldMidProvision`):
 *  - BOOT (`shieldMidProvision: false`): a null-state open row is a crash-mid-`up`
 *    orphan (state is persisted only AFTER the up-to-120s `up --wait` returns, so a
 *    crash during it leaves no state) — it must be REAPED, not shielded. This
 *    preserves the documented invariant "server crash mid-`up --wait` → reaped next
 *    boot". Boot runs BEFORE the HTTP routes, so no create can be in flight.
 *  - PERIODIC (`shieldMidProvision: true`): a null-state open row may be a create
 *    that is CURRENTLY inside its `up --wait` window. Reaping it would down a stack
 *    that is legitimately coming up. So the periodic reaper SHIELDS the deterministic
 *    compose name of every null-state open row. (`provisionServicesForLaunch` has a
 *    single caller — the create path — so relaunch never re-provisions; an open
 *    "error"/"down" row is therefore never mid-provision and stays reapable.)
 *
 * In BOTH cases only a status-"up" row shields its stored compose name (#52 Half 2:
 * an open "error"/"down" row must not be reaper-immune). Terminal (closed/merged)
 * rows are excluded from the query entirely, so their orphaned stacks are always
 * reapable. The instance-scoped filter inside the engine
 * (`isInstanceManagedComposeProject`) still guarantees another board instance's
 * stacks — and legacy unscoped `ak-ws-…` names — are never touched.
 */

import { isNotNull, notInArray } from "drizzle-orm";
import { composeProjectName } from "@agentic-kanban/shared";
import { TERMINAL_WORKSPACE_STATUSES } from "@agentic-kanban/shared/lib/workspace-status";
import { dockerAvailable } from "@agentic-kanban/shared/lib/docker-exec";
import { workspaces, projects } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import {
  workspaceServicesService,
  parseStoredServiceStackState,
} from "../services/workspace-services.service.js";
import { getOrCreateServiceStackInstanceId } from "../repositories/workspace-service-state.repository.js";

const TERMINAL_STATUSES: string[] = [...TERMINAL_WORKSPACE_STATUSES];

/** An open workspace row, as the reaper needs it to build the known-stacks set. */
export interface OpenWorkspaceStackRow {
  workspaceId: string;
  serviceState: string | null;
}

/**
 * Build the set of compose project names the reaper must NOT down — the "known" set.
 * See the module header for why `shieldMidProvision` differs between boot and periodic.
 *
 *  - status "up"          → shield the STORED compose name (a live stack).
 *  - no parsed state, and `shieldMidProvision` → shield the DETERMINISTIC name
 *    (a create possibly still inside its `up --wait` window; harmless for a
 *    workspace that never had a stack — no such compose project exists).
 *  - status "error"/"down", or null-at-boot → NOT shielded (reapable): an open
 *    workspace whose stack failed or was torn down must not be reaper-immune (#52).
 */
export function buildKnownComposeProjectNames(
  rows: OpenWorkspaceStackRow[],
  instanceId: string,
  opts: { shieldMidProvision: boolean },
): Set<string> {
  const known = new Set<string>();
  for (const row of rows) {
    const state = parseStoredServiceStackState(row.serviceState);
    if (state && state.status === "up") {
      if (state.composeProjectName) known.add(state.composeProjectName);
      continue;
    }
    if (!state && opts.shieldMidProvision) {
      try {
        known.add(composeProjectName(row.workspaceId, instanceId));
      } catch {
        // Unusable instance id — the engine's own instance filter no-ops safely.
      }
    }
    // else: "error"/"down" (any time) or null-at-boot → reapable, add nothing.
  }
  return known;
}

export interface ReapOnceDeps {
  database?: Database;
  /** Injectable for tests; defaults to the process-wide docker-backed engine. */
  reap?: (args: { knownComposeProjectNames: Set<string> }) => Promise<{ reaped: string[] }>;
  resolveInstanceId?: () => Promise<string>;
  isDockerAvailable?: (env?: NodeJS.ProcessEnv) => Promise<boolean>;
  /** Whether a null-state open row shields its deterministic name (periodic) or not (boot). */
  shieldMidProvision: boolean;
  /** Log prefix, e.g. "startup" or "services-reaper". */
  logLabel: string;
}

/**
 * Run one reap pass. Best-effort — every failure is logged and swallowed so it can
 * never block startup or crash a background tick. Returns the reaped names for tests.
 */
export async function reapOrphanServiceStacksOnce(deps: ReapOnceDeps): Promise<{ reaped: string[] }> {
  const database = deps.database ?? db;
  const label = deps.logLabel;
  try {
    // Query every non-terminal workspace (id + state). We need null-state rows too:
    // the periodic pass shields their deterministic names against an in-flight create.
    const openRows: OpenWorkspaceStackRow[] = await database
      .select({ workspaceId: workspaces.id, serviceState: workspaces.serviceState })
      .from(workspaces)
      .where(notInArray(workspaces.status, TERMINAL_STATUSES));

    // Cheap pre-check BEFORE the (up to 5s) docker probe: if NO open workspace ever
    // provisioned a stack AND no project even has services enabled, there is nothing
    // to reap — skip the probe so a "docker installed but stopped" host doesn't pay
    // 5s every tick.
    const anyRowHasState = openRows.some((r) => r.serviceState != null);
    let anyProjectStackEnabled = false;
    if (!anyRowHasState) {
      const projectRows = await database
        .select({ servicesConfig: projects.servicesConfig })
        .from(projects)
        .where(isNotNull(projects.servicesConfig));
      anyProjectStackEnabled = projectRows.some((r) => {
        try {
          const parsed = JSON.parse(r.servicesConfig ?? "null") as { enabled?: unknown } | null;
          return parsed?.enabled === true;
        } catch {
          return false;
        }
      });
    }
    if (!anyRowHasState && !anyProjectStackEnabled) return { reaped: [] };

    const isDockerAvailable = deps.isDockerAvailable ?? dockerAvailable;
    if (!(await isDockerAvailable())) return { reaped: [] };

    const resolveInstanceId = deps.resolveInstanceId ?? (() => getOrCreateServiceStackInstanceId());
    let instanceId: string;
    try {
      instanceId = await resolveInstanceId();
    } catch (err) {
      // Without a proven identity we must not down ANYTHING on the shared daemon.
      console.warn(`[${label}] service-stack reaper skipped — could not resolve this instance's id: ${err instanceof Error ? err.message : String(err)}`);
      return { reaped: [] };
    }

    const known = buildKnownComposeProjectNames(openRows, instanceId, { shieldMidProvision: deps.shieldMidProvision });
    const reap = deps.reap ?? ((args) => workspaceServicesService.reapOrphanServiceStacks(args));
    const { reaped } = await reap({ knownComposeProjectNames: known });
    if (reaped.length > 0) {
      console.log(`[${label}] reaped ${reaped.length} orphan service stack(s): ${reaped.join(", ")}`);
    }
    return { reaped };
  } catch (err) {
    console.warn(`[${label}] service-stack reaper failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return { reaped: [] };
  }
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 60 * 1000;

let activeReaperTimeout: ReturnType<typeof setTimeout> | null = null;
let activeReaperInterval: ReturnType<typeof setInterval> | null = null;

export function stopServiceStackReaper(): void {
  if (activeReaperTimeout !== null) {
    clearTimeout(activeReaperTimeout);
    activeReaperTimeout = null;
  }
  if (activeReaperInterval !== null) {
    clearInterval(activeReaperInterval);
    activeReaperInterval = null;
  }
}

/**
 * Start the PERIODIC reaper (background-services registry). Shields in-flight creates
 * (`shieldMidProvision: true`) since it runs concurrently with HTTP workspace creation.
 * Timers are `unref`'d so they never keep the process alive. Best-effort per tick.
 */
export function startServiceStackReaper(
  deps: Partial<Omit<ReapOnceDeps, "shieldMidProvision" | "logLabel">> = {},
  intervalMs = DEFAULT_INTERVAL_MS,
): void {
  stopServiceStackReaper();
  const tick = () => {
    reapOrphanServiceStacksOnce({ ...deps, shieldMidProvision: true, logLabel: "services-reaper" }).catch((err) =>
      console.warn("[services-reaper] periodic tick error:", err instanceof Error ? err.message : err),
    );
  };
  const timer = setTimeout(tick, INITIAL_DELAY_MS);
  const interval = setInterval(tick, intervalMs);
  activeReaperTimeout = timer;
  activeReaperInterval = interval;
  timer.unref?.();
  interval.unref?.();
}
