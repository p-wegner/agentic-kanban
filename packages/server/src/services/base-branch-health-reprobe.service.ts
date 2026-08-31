/**
 * WHETHER a base-branch health probe should start, and the on-demand door that asks for one.
 *
 * Split out of `startup/base-branch-health-reconciler.ts` (#947). The sweep that lives there is
 * genuinely a `server-monitor` — a timer registered in `BACKGROUND_SERVICES`. This half is not:
 * it is a decision plus an orchestration call that TWO non-monitor callers need — the reprobe
 * route (`routes/project-health.ts`) and the merge gate (`services/workspace-merge-gate.ts`).
 * While it sat in `startup/`, the route's import was a `server-route -> server-monitor`
 * pattern-rule violation and the gate's was a dynamic `import()` written specifically to dodge
 * the `services/ -> startup/` layering rule (#595). Both are the same defect seen from two
 * sides: a service-shaped decision parked in the composition/monitor layer.
 *
 * The sweep now imports DOWN into here, which is the direction the layering already allows.
 */

import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import {
  verifyBaseBranchHealth,
  baseHealthProbeStartPrefKey,
  PROBE_MAX_DURATION_MS,
} from "./base-branch-health.service.js";
import { getLatestBaseBranchHealth, type BaseBranchHealthOutcome } from "../repositories/base-branch-health.repository.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { buildGateBusy } from "./jvm-build-semaphore.js";
import {
  inspectMachineVerifyLock,
  machineVerifyLockEnabled,
} from "../lib/machine-verify-lock.js";

/** Default cadence of the periodic sweep; also the recency window an on-demand ask is judged against. */
export const BASE_HEALTH_DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

/**
 * "Is heavyweight verification running right now?" — the ONE signal (#957).
 *
 * `buildGateBusy()` answers that for THIS process only, which is what let a worktree dev server's
 * gate, a second board server, or a builder's own `pnpm test:mine` run beside a probe with
 * nothing noticing. The machine lock sees those; this ORs the two so callers keep asking one
 * question and get an answer that covers the box rather than the event loop.
 *
 * A lock held by OUR OWN pid is deliberately not counted: this process's own holder is already
 * what `buildGateBusy()` reports, and double-counting it would make a probe that legitimately
 * holds the lock consider itself busy. Cheap enough to call per decision — one `existsSync` plus
 * at most one small read, and only when the lock is switched on at all.
 */
export function resolveGateBusy(): boolean {
  if (buildGateBusy()) return true;
  if (!machineVerifyLockEnabled()) return false;
  const held = inspectMachineVerifyLock();
  if (!held) return false;
  // Stale or confirmed-dead holders are reclaimable, so they are not "running" by any useful
  // reading — treating them as busy would let one crashed process starve the probe indefinitely.
  if (held.isStale && !held.ownerProcessAlive) return false;
  return held.contents.pid !== process.pid;
}

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
   * Read by the caller — kept as an input rather than read in here so this stays a pure decision
   * function. The probe is the least urgent of the three uncoordinated test-spawning paths
   * (gate, builder, base-health) and its result is not time-critical, so it is the one that
   * yields.
   *
   * **#957 reconciled this with the machine lock instead of stacking a second signal.** The
   * ticket's third design question was exactly that: a machine-wide lock overlaps `buildGateBusy()`
   * and the two should be one thing. They are — `resolveGateBusy()` below ORs the in-process
   * semaphore with "some OTHER process holds the machine verify lock", and this field keeps
   * meaning precisely what it meant before: "heavyweight verification is running right now, so
   * yield". What changed is only that it can now see past this process's own boundary, which is
   * the blindness #957 exists to remove. A second `machineLockBusy` input would have forced every
   * caller to re-derive the same disjunction and let the two drift.
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
 * Read the persisted probe state for a project and decide whether one is due.
 *
 * Shared by the on-demand door below and the periodic sweep, which had the same six lines
 * duplicated — the sweep now calls this rather than re-assembling the input itself.
 */
export async function resolveBaseHealthProbeDue(
  projectId: string,
  database: Database,
  intervalMs: number,
  nowMs: number,
): Promise<BaseHealthDueVerdict> {
  const latest = await getLatestBaseBranchHealth(projectId, database).catch(() => null);
  const probeStartedAt = await getPreference(baseHealthProbeStartPrefKey(projectId), database).catch(() => null);
  return isBaseHealthProbeDue({
    nowMs,
    intervalMs,
    lastResultAt: latest?.createdAt ?? null,
    lastOutcome: latest?.outcome ?? null,
    probeStartedAt,
    // #957 — the machine-wide reading, not just this process's. See `resolveGateBusy`.
    gateBusy: resolveGateBusy(),
  });
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
 * The in-flight map in the probe service dedups two probes that overlap; it says nothing about
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
  intervalMs = BASE_HEALTH_DEFAULT_INTERVAL_MS,
  nowMs: number = Date.now(),
  opts: { ignoreRecency?: boolean } = {},
): Promise<BaseHealthDueVerdict> {
  let verdict: BaseHealthDueVerdict = { due: false, reason: "recent_result" };
  try {
    verdict = await resolveBaseHealthProbeDue(projectId, database, intervalMs, nowMs);
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
