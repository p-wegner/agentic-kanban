/**
 * Periodic base-branch health check (#491). Runs `verify_script` against every registered
 * project's CURRENT base-branch tip and persists the result, so "is the base green right now"
 * has an answer independent of any branch's own pre-merge gate.
 *
 * Deliberately best-effort and slow-paced: this is a background signal, not a gate, and each
 * project's verify run can itself take many minutes. Projects with no `verify_script`
 * configured are skipped cheaply (checked inside `verifyBaseBranchHealth`, itself a no-op).
 */

import { projects as projectsTable } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import {
  verifyBaseBranchHealth,
  baseHealthProbeStartPrefKey,
  PROBE_MAX_DURATION_MS,
} from "../services/base-branch-health.service.js";
import { getLatestBaseBranchHealth, type BaseBranchHealthOutcome } from "../repositories/base-branch-health.repository.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 2 * 60 * 1000;

export interface BaseHealthDueInput {
  /** Epoch ms — pure arithmetic, hence `nowMs` (#614's vocabulary). */
  nowMs: number;
  intervalMs: number;
  /** `createdAt` of the newest recorded result, or null when the project has none. */
  lastResultAt?: string | null;
  /** Outcome of that newest result — a `timeout` is backed off differently. */
  lastOutcome?: BaseBranchHealthOutcome | string | null;
  /** ISO start stamp of a probe believed to still be running (empty/null = none). */
  probeStartedAt?: string | null;
}

export interface BaseHealthDueVerdict {
  due: boolean;
  reason: "no_history" | "interval_elapsed" | "probe_in_flight" | "recent_result";
}

/**
 * Whether a project's base branch is due for a probe (#712). Pure and synchronous on purpose:
 * every one of the four defects this encodes is a comparison, and a table of comparisons is a
 * far better test than a sweep that needs a database.
 */
export function isBaseHealthProbeDue(input: BaseHealthDueInput): BaseHealthDueVerdict {
  const { nowMs, intervalMs } = input;

  // 1. A probe is already running (persisted, so a restart cannot forget it). A stamp older
  //    than the probe's own ceiling belongs to a process that was killed mid-run — trusting it
  //    forever would wedge the project permanently, so it EXPIRES rather than blocks.
  const startMs = input.probeStartedAt ? Date.parse(input.probeStartedAt) : NaN;
  if (Number.isFinite(startMs) && startMs <= nowMs && nowMs - startMs < PROBE_MAX_DURATION_MS) {
    return { due: false, reason: "probe_in_flight" };
  }

  const lastMs = input.lastResultAt ? Date.parse(input.lastResultAt) : NaN;
  if (!Number.isFinite(lastMs)) return { due: true, reason: "no_history" };

  // 2. A FUTURE `createdAt` (clock skew, a restored DB, a hand-written row) made
  //    `nowMs - lastMs` negative, which is always "< intervalMs" — so the sweep went silently
  //    dead for that project until wall-clock caught up. An unusable stamp is distrusted, not
  //    obeyed: treat it as infinitely old and probe.
  const ageMs = lastMs > nowMs ? Number.POSITIVE_INFINITY : nowMs - lastMs;

  // 3. A `timeout` result means the probe burned its whole budget without answering. With the
  //    plain interval (30 min) shorter than the verify ceiling (45 min) and no outcome filter,
  //    such a project was due again immediately on every pass — it ran continuously. Back it
  //    off by at least the runtime it just spent.
  const effectiveIntervalMs = input.lastOutcome === "timeout"
    ? intervalMs + PROBE_MAX_DURATION_MS
    : intervalMs;

  if (ageMs < effectiveIntervalMs) return { due: false, reason: "recent_result" };
  return { due: true, reason: "interval_elapsed" };
}

let activeSweep: PeriodicSweepHandle | null = null;
let tickInFlight = false;

export function stopBaseBranchHealthReconciler(): void {
  activeSweep?.stop();
  activeSweep = null;
}

/**
 * Run one pass: verify every registered project's base branch, sequentially.
 *
 * A project whose last recorded result is NEWER than one interval is skipped (#699 follow-up).
 *
 * Without that, the "periodic" in this sweep's name was not true. `INITIAL_DELAY_MS` is two
 * minutes and `tsx watch` restarts the dev server on every merge, so a run of merges re-armed
 * the sweep from scratch each time and it started over — a full `verify_script` for EVERY
 * registered project, ~25 of them, serially. Measured today: it was running a second complete
 * copy of `pnpm check:arch && pnpm typecheck && pnpm test:mine` on the main checkout alongside
 * a developer's own suite, which is the most likely source of the `Worker exited unexpectedly`
 * crashes and 5s guard-suite timeouts that read as unrelated test failures.
 *
 * `tickInFlight` never covered this: it guards a pass against ITSELF within one process, and
 * every one of these passes was in a freshly restarted process. Persisted recency is the only
 * thing a restart cannot forget.
 *
 * #712 completed that argument. Recency was stamped only at the END of a probe, so throughout
 * the 45–60 minutes one ran, the persisted "last result" was still the OLD one and every
 * restart in that window started a rival verify anyway. The probe now also stamps its START
 * (a preference, see `baseHealthProbeStartPrefKey`), and `isBaseHealthProbeDue` reads both —
 * along with the two arithmetic defects at the same site: a `timeout` outcome being due again
 * before it could even have finished, and a future `createdAt` making the delta negative and
 * so silently permanently "recent".
 */
export async function runBaseBranchHealthCheckOnce(
  database: Database = db,
  intervalMs = DEFAULT_INTERVAL_MS,
  nowMs: number = Date.now(),
): Promise<void> {
  if (tickInFlight) return; // a prior pass is still running (verify can take many minutes)
  tickInFlight = true;
  try {
    const rows = await database
      .select({ id: projectsTable.id })
      .from(projectsTable);
    for (const { id } of rows) {
      try {
        const latest = await getLatestBaseBranchHealth(id, database).catch(() => null);
        const probeStartedAt = await getPreference(baseHealthProbeStartPrefKey(id), database).catch(() => null);
        const verdict = isBaseHealthProbeDue({
          nowMs,
          intervalMs,
          lastResultAt: latest?.createdAt ?? null,
          lastOutcome: latest?.outcome ?? null,
          probeStartedAt,
        });
        if (!verdict.due) continue;
        await verifyBaseBranchHealth(id, database);
      } catch (err) {
        console.warn(`[base-branch-health] check failed for project ${id} (non-fatal):`, err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    console.warn("[base-branch-health] periodic tick error:", err instanceof Error ? err.message : String(err));
  } finally {
    tickInFlight = false;
  }
}

/** Start the periodic base-branch health reconciler (background-services registry). */
export function startBaseBranchHealthReconciler(database: Database = db, intervalMs = DEFAULT_INTERVAL_MS): void {
  stopBaseBranchHealthReconciler();
  activeSweep = startPeriodicSweep({
    name: "base-branch-health",
    intervalMs,
    bootDelayMs: INITIAL_DELAY_MS,
    tick: () => runBaseBranchHealthCheckOnce(database, intervalMs),
  });
}
