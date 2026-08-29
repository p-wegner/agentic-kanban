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
import { buildGateBusy } from "../services/jvm-build-semaphore.js";

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
  /**
   * Is a pre-merge gate's heavyweight verify/build/smoke work running right now (#931)?
   * Read from `buildGateBusy()` by the caller — kept as an input rather than read in here so
   * this stays a pure decision function. The probe is the least urgent of the three
   * uncoordinated test-spawning paths (gate, builder, base-health) and its result is not
   * time-critical, so it is the one that yields.
   */
  gateBusy?: boolean;
}

export interface BaseHealthDueVerdict {
  due: boolean;
  reason: "no_history" | "interval_elapsed" | "probe_in_flight" | "recent_result" | "gate_running";
}

/**
 * Whether a project's base branch is due for a probe (#712, #931). Pure and synchronous on
 * purpose: every one of the defects this encodes is a comparison, and a table of comparisons
 * is a far better test than a sweep that needs a database.
 */
export function isBaseHealthProbeDue(input: BaseHealthDueInput): BaseHealthDueVerdict {
  const { nowMs, intervalMs } = input;

  // 0. A merge gate is spending the box's cores right now (#931: 22 vitest workers measured
  //    from three uncoordinated runs at once). Deferred, not skipped — the interval-elapsed
  //    check below still applies next tick, so a busy gate only delays the probe, never
  //    starves it permanently.
  if (input.gateBusy) {
    return { due: false, reason: "gate_running" };
  }

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

/**
 * Ask for a fresh probe on demand, but only if one is actually DUE (#935).
 *
 * The gate and the reprobe route both want "the base's cached verdict is a non-answer, measure
 * it again". Calling `verifyBaseBranchHealth` straight from those sites bypasses BOTH guards
 * that keep this probe from being the thing it measures: the `gateBusy` yield (#931 — the probe
 * is the least urgent of the three test-spawning paths and is the one that gives way) and the
 * `timeout` back-off (#712 — a timed-out probe is not due again until it has had at least its
 * own runtime to breathe). Without them a project stuck on a sticky non-answer row re-spawns a
 * clone + install + 45-minute verify on EVERY failing gate, on the saturated box whose
 * saturation produced the non-answer in the first place.
 *
 * The in-flight map in the service dedups two probes that overlap; it says nothing about
 * whether a probe should start at all. That decision is `isBaseHealthProbeDue`, and it lives
 * here — so every caller that wants a probe "if it makes sense" comes through this door.
 *
 * Never throws, and resolves on the DECISION rather than on the probe: a probe is minutes to
 * an hour, and both callers (a failing merge gate, an HTTP route) need to carry on immediately.
 * The probe itself runs detached; its result lands in the next read of the health row.
 */
export async function requestBaseBranchReprobe(
  projectId: string,
  database: Database = db,
  intervalMs = DEFAULT_INTERVAL_MS,
  nowMs: number = Date.now(),
  opts: { ignoreRecency?: boolean } = {},
): Promise<BaseHealthDueVerdict> {
  let verdict: BaseHealthDueVerdict = { due: false, reason: "recent_result" };
  try {
    const latest = await getLatestBaseBranchHealth(projectId, database).catch(() => null);
    const probeStartedAt = await getPreference(baseHealthProbeStartPrefKey(projectId), database).catch(() => null);
    verdict = isBaseHealthProbeDue({
      nowMs,
      intervalMs,
      lastResultAt: latest?.createdAt ?? null,
      lastOutcome: latest?.outcome ?? null,
      probeStartedAt,
      gateBusy: buildGateBusy(),
    });
    // An EXPLICIT operator request ("that verdict was starved, measure again") is allowed to
    // override the recency/timeout back-off — overriding it is the whole point of the route,
    // and the ticket asks for exactly that. It is NOT allowed to override the two guards that
    // protect the machine: a probe already running (`probe_in_flight`) or a gate spending the
    // cores right now (`gate_running`). Those are why the starved verdict exists.
    if (opts.ignoreRecency && !verdict.due && verdict.reason === "recent_result") {
      verdict = { due: true, reason: "interval_elapsed" };
    }
    if (!verdict.due) {
      console.log(
        `[base-branch-health] on-demand re-probe for project ${projectId} skipped (${verdict.reason})`,
      );
      return verdict;
    }
    // Detached on purpose — see the doc comment. The probe's own errors are non-fatal to the
    // caller that asked for it.
    void verifyBaseBranchHealth(projectId, database).catch((err) => {
      console.warn(
        `[base-branch-health] on-demand re-probe failed for project ${projectId} (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      );
    });
  } catch (err) {
    console.warn(
      `[base-branch-health] on-demand re-probe could not be decided for project ${projectId} (non-fatal):`,
      err instanceof Error ? err.message : String(err),
    );
  }
  return verdict;
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
          gateBusy: buildGateBusy(),
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
