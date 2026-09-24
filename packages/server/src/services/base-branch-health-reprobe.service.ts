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
  BASE_HEALTH_PROBE_START_PREF_PREFIX,
  PROBE_MAX_DURATION_MS,
} from "./base-branch-health.service.js";
import {
  getLatestBaseBranchHealth,
  isBaseHealthAnswer,
  type BaseBranchHealthOutcome,
} from "../repositories/base-branch-health.repository.js";
import { getProjectById } from "../repositories/project.repository.js";
import { revParse } from "@agentic-kanban/shared/lib/git-service";
import { getPreference, getAllPreferences, setPreference } from "../repositories/preferences.repository.js";
import { buildGateBusy, buildSemaphoreActive, buildSemaphoreOldestActiveAgeMs } from "./jvm-build-semaphore.js";
import {
  inspectMachineVerifyLock,
  machineVerifyLockEnabled,
  describeHolder,
} from "../lib/machine-verify-lock.js";
import {
  readTier0Capacity,
  readCpuBusyPct,
  classifyHeavyProbeSaturation,
  type Tier0Capacity,
  type HeavyProbeSaturation,
} from "@agentic-kanban/shared/lib/machine-capacity";

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

/**
 * WHO is holding the "gate running" slot `resolveGateBusy()` reports, and for how long (#1084).
 *
 * `resolveGateBusy()` collapses two independent sources (this process's build semaphore, the
 * cross-process machine lock) into one boolean, which is correct for the yield decision but
 * leaves a `gate_running` reprobe refusal unexplainable without reading source — an operator
 * cannot tell "legitimately busy" from "stuck" from the HTTP response alone. This names the
 * source, a holder count/description, and the oldest holder's age, so the reprobe route can say
 * why it refused instead of just that it refused.
 */
export interface GateBusyDiagnostics {
  busy: boolean;
  /** Which signal is reporting busy — null when neither is. Both can be true; semaphore wins for
   *  display since it is this process's own accounting and always has an exact holder count. */
  source: "semaphore" | "machine-lock" | null;
  /** Number of in-flight tasks holding the in-process semaphore. */
  semaphoreActive: number;
  /** Age (ms) of the oldest in-process semaphore holder, or null when none is active. */
  semaphoreOldestActiveAgeMs: number | null;
  /** Free-text description of the machine-lock holder (role/pid/host/duration), or null. */
  machineLockHolder: string | null;
}

/** Snapshot of {@link resolveGateBusy}'s two inputs, for a caller that needs to explain "why". */
export function describeGateBusy(nowMs: number = Date.now()): GateBusyDiagnostics {
  const semaphoreActive = buildSemaphoreActive();
  const semaphoreOldestActiveAgeMs = buildSemaphoreOldestActiveAgeMs(nowMs);
  let machineLockHolder: string | null = null;
  if (machineVerifyLockEnabled()) {
    const held = inspectMachineVerifyLock(nowMs);
    if (held && !(held.isStale && !held.ownerProcessAlive) && held.contents.pid !== process.pid) {
      machineLockHolder = describeHolder(held);
    }
  }
  const busy = semaphoreActive > 0 || machineLockHolder !== null;
  const source: GateBusyDiagnostics["source"] = semaphoreActive > 0
    ? "semaphore"
    : machineLockHolder !== null
      ? "machine-lock"
      : null;
  return { busy, source, semaphoreActive, semaphoreOldestActiveAgeMs, machineLockHolder };
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
  /**
   * The base branch's CURRENT sha, when resolvable (#978).
   *
   * Absent/null means "could not be read" and restores the pre-#978 behaviour exactly — the
   * decision falls through to the interval. That fail-open is deliberate: an unreadable sha
   * must cost an extra probe, never a skipped one, because the failure mode of the other
   * direction is a base whose health is never re-measured.
   */
  currentSha?: string | null;
  /** The sha the newest recorded result was measured at, or null when there is no history. */
  lastResultSha?: string | null;
  /**
   * The Tier-0 host-saturation reason when the box is below the free-RAM floor the monitor
   * applies to auto-starts (`readTier0Capacity`), else null/undefined (#1009).
   *
   * A probe is a clone + install + full verify; launching one onto a host the monitor would
   * not even start a builder on is how #999's base run and branch gate both timed out. Read by
   * the caller (`resolveBaseHealthProbeDue`) so this stays a pure decision. DEFERS, never
   * skips: the interval check runs again next tick, and a persistently tight box only delays
   * the measurement.
   */
  hostSaturated?: string | null;
}

export interface BaseHealthDueVerdict {
  due: boolean;
  reason:
    | "no_history"
    | "interval_elapsed"
    | "probe_in_flight"
    | "recent_result"
    | "gate_running"
    | "sha_unchanged"
    | "host_saturated";
  /**
   * Present only when `reason === "probe_in_flight"` (#1223). An operator (or `promote.mjs`)
   * cannot tell a live probe from a corpse whose owning process was killed mid-run — both read
   * as the same unqualified "probe_in_flight" — so this names the stamp's own start time and its
   * expiry under `PROBE_MAX_DURATION_MS`, the numbers a reader needs to decide whether waiting
   * makes sense. `startedAt` is the persisted ISO stamp; `expiresAt` is when
   * `isBaseHealthProbeDue` stops trusting it.
   */
  probeInFlightSince?: { startedAt: string; expiresAt: string };
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
    return {
      due: false,
      reason: "probe_in_flight",
      probeInFlightSince: {
        startedAt: input.probeStartedAt as string,
        expiresAt: new Date(startMs + PROBE_MAX_DURATION_MS).toISOString(),
      },
    };
  }

  // 1b. #1009 — the host is below the same free-RAM floor the monitor holds auto-starts at.
  //     After the two machine-state checks above (a running probe is running, whatever the
  //     box looks like) and BEFORE every "is it time" check below: a due probe on a saturated
  //     host is deferred, and the answer to "why did the probe not run" is the saturation,
  //     not the interval.
  if (input.hostSaturated) {
    return { due: false, reason: "host_saturated" };
  }

  const lastMs = input.lastResultAt ? Date.parse(input.lastResultAt) : NaN;
  if (!Number.isFinite(lastMs)) return { due: true, reason: "no_history" };

  // 1a. #978 — the base has not MOVED since a probe last answered about it, so the answer is
  //     still the answer and the 30-minute interval is measuring nothing. Master only moves on
  //     a merge, so on a quiet board this removes essentially every probe run — and each one it
  //     removes is a clone + install + full verify that was occupying the box's single verify
  //     slot. #971's merge gate waited ~35 minutes behind exactly that.
  //
  //     Only an ANSWER (green/red) counts. A `timeout`/`unverified` at this sha means the probe
  //     learned nothing about it, so re-probing the same sha is the point rather than a waste;
  //     that case still falls through to the interval and to the timeout back-off below.
  if (
    input.currentSha
    && input.lastResultSha
    && input.currentSha === input.lastResultSha
    && isBaseHealthAnswer(input.lastOutcome)
  ) {
    return { due: false, reason: "sha_unchanged" };
  }

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
 * The base branch's current sha, or null when it cannot be read (#978).
 *
 * Total by construction: an unregistered project, a moved checkout, a repo with no such branch
 * and a git failure all yield null, which the decision treats as "no sha information" and
 * falls back to the interval. It reads the same `revParse(repoPath, defaultBranch)` the probe
 * itself uses to stamp the row, so the two shas are comparable by construction rather than by
 * convention.
 */
async function resolveBaseBranchSha(projectId: string, database: Database): Promise<string | null> {
  const project = await getProjectById(projectId, database).catch(() => null);
  if (!project?.repoPath || !project.defaultBranch) return null;
  return revParse(project.repoPath, project.defaultBranch).catch(() => null);
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
  opts: {
    /** Injected for tests; defaults to the live Tier-0 read (#1009). */
    readCapacity?: () => Tier0Capacity;
    /** Injected for tests; defaults to the live CPU sample (#1173). */
    readCpuPct?: () => Promise<number | null>;
  } = {},
): Promise<BaseHealthDueVerdict> {
  const latest = await getLatestBaseBranchHealth(projectId, database).catch(() => null);
  const probeStartedAt = await getPreference(baseHealthProbeStartPrefKey(projectId), database).catch(() => null);
  // #1009 / #1173 — the probe is heavier than a single builder start (a clone + install + full
  // verify), so it is held below its OWN floor rather than the lighter builder one: usable RAM
  // < 4 GB (vs the 2 GB `readTier0Capacity` default) OR CPU >= 85%, the same two thresholds the
  // operating conventions ask a human to check before a parallel test/build run. Measured gap
  // this closes: a probe that ran at 100% CPU start-to-end with free RAM never below 3.1 GB
  // (so the old RAM-only 2 GB floor never tripped) burned its full 45-minute cap for a `timeout`
  // — a non-answer that also superseded a usable green row. Fail-open by construction: either
  // reading that cannot be taken contributes no hold.
  const capacity = (opts.readCapacity ?? readTier0Capacity)();
  const cpuPct = await (opts.readCpuPct ?? readCpuBusyPct)().catch(() => null);
  const saturation: HeavyProbeSaturation = classifyHeavyProbeSaturation({ freeGb: capacity.freeGb, cpuPct });
  return isBaseHealthProbeDue({
    hostSaturated: saturation.hold ? saturation.reason : null,
    nowMs,
    intervalMs,
    lastResultAt: latest?.createdAt ?? null,
    lastOutcome: latest?.outcome ?? null,
    lastResultSha: latest?.sha ?? null,
    // #978 — read here rather than inside the decision, which stays pure. Every failure path
    // yields null and so restores the interval-only behaviour; see `currentSha`'s comment.
    currentSha: await resolveBaseBranchSha(projectId, database),
    probeStartedAt,
    // #957 — the machine-wide reading, not just this process's. See `resolveGateBusy`.
    gateBusy: resolveGateBusy(),
  });
}

/**
 * Ask for a fresh probe on demand, but only if one is actually DUE (#935).
 *
 * The gate and the reprobe route both want "the base's cached verdict is a non-answer, measure
 * it again". Calling `verifyBaseBranchHealth` straight from those sites bypasses the guards that
 * keep this probe from being the thing it measures: the `gateBusy` yield (#931 — the UNATTENDED
 * sweep's probe is the least urgent of the three test-spawning paths and is the one that gives
 * way) and the `timeout` back-off (#712 — a timed-out probe is not due again until it has had at
 * least its own runtime to breathe). Without them a project stuck on a sticky non-answer row
 * re-spawns a clone + install + 45-minute verify on EVERY failing gate, on the saturated box
 * whose saturation produced the non-answer in the first place.
 *
 * The in-flight map in the probe service dedups two probes that overlap; it says nothing about
 * whether a probe should start at all. That decision is `isBaseHealthProbeDue`, and it lives
 * here — so every caller that wants a probe "if it makes sense" comes through this door.
 *
 * **`gate_running` is the one reason an EXPLICIT `ignoreRecency` request may override (#1165).**
 * Back-to-back merge gates keep `resolveGateBusy()` true almost continuously — one ends, the next
 * begins — so refusing the on-demand door on it too makes a stuck red verdict permanently
 * unclearable: every gate that would benefit from a fresh probe is itself what keeps the probe
 * from ever being asked for. The probe it starts still queues at the real resource (the
 * verify-chain semaphore) as a `background`-priority waiter with its own starvation escape, so
 * this override cannot reintroduce #931's two-full-verifies-at-once failure — it only lets an
 * explicit, singular request reach the queue instead of being refused before it gets there.
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
  opts: {
    ignoreRecency?: boolean;
    readCapacity?: () => Tier0Capacity;
    readCpuPct?: () => Promise<number | null>;
    /** #1238 — probe this branch (a release candidate) instead of the project's base branch. */
    branch?: string | null;
  } = {},
): Promise<BaseHealthDueVerdict> {
  let verdict: BaseHealthDueVerdict = { due: false, reason: "recent_result" };
  try {
    verdict = await resolveBaseHealthProbeDue(projectId, database, intervalMs, nowMs, {
      readCapacity: opts.readCapacity,
      readCpuPct: opts.readCpuPct,
    });
    // An EXPLICIT operator request ("that verdict was starved, measure again") is allowed to
    // override the recency/timeout back-off — overriding it is the whole point of the route,
    // and the ticket asks for exactly that. It is NOT allowed to override the one guard that
    // protects the machine from a REDUNDANT run: a probe already running for this project
    // (`probe_in_flight`) is joined for free by the in-flight map, so a second explicit request
    // would only pay for a second clone+install to learn nothing new.
    // `sha_unchanged` joins `recent_result` here (#978): both are "we already know the
    // answer", and an operator pressing re-probe is saying they do not believe it.
    //
    // `gate_running` is DELIBERATELY overridable here (#1165). That reason exists to keep the
    // unattended periodic sweep from piling an uncoordinated probe onto a box a gate is already
    // using — it is not a promise that the box has a free verify slot. Back-to-back merge gates
    // make `resolveGateBusy()` true almost continuously (one ends, the next begins), so refusing
    // an explicit reprobe on it forever starves the one thing that could clear a stuck
    // BASE BRANCH ALREADY RED verdict — the reprobe can never find a gap, and every gate keeps
    // refusing against the same stale verdict it would have fixed. The probe itself still queues
    // for the real resource, the verify-chain semaphore, as `priority: "background"`
    // (`runBaseBranchProbe`) — which already has a starvation escape
    // (`verifyChainBackgroundMaxWaitMs`, default 30 min) so it cannot be overtaken by gates
    // forever. So overriding this pre-check does not restore #931's two-full-verifies-at-once
    // failure: it only lets the probe reach the queue it was always going to wait in.
    if (opts.ignoreRecency && !verdict.due
      && (verdict.reason === "recent_result" || verdict.reason === "sha_unchanged" || verdict.reason === "gate_running")) {
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
    // An `ignoreRecency` request is someone blocked on the answer (an operator, `pnpm promote`):
    // it runs at gate priority and does not yield to gates, or #1165's override only lets it
    // reach a slot it then hands back (see `BaseBranchProbeOptions`).
    // #1238 — a named branch is a candidate sweep: `explicit` by construction (someone is blocked
    // on it), and the branch rides on the options so the row is stamped with what was measured.
    void verifyBaseBranchHealth(projectId, database, undefined, {
      explicit: opts.ignoreRecency === true || Boolean(opts.branch),
      ...(opts.branch ? { branch: opts.branch } : {}),
    }).catch((err) => {
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

/**
 * Clear every persisted "probe started" stamp on boot (#1223).
 *
 * `base_health_probe_started_<projectId>` is deliberately persisted so a restart mid-probe does
 * not forget it — `isBaseHealthProbeDue` trusts the stamp for up to `PROBE_MAX_DURATION_MS`
 * (65 min) before treating it as abandoned. That is the right safety property for a LIVE
 * process, but a freshly-booted process starts with an empty `inFlightProbes` map: nothing it
 * runs from now on could possibly be the probe that wrote an inherited stamp, so a stamp already
 * on disk at boot can only be one thing — the write half of `runBaseBranchProbe`'s `finally`
 * (which clears it on completion) never ran, because the owning process was killed, restarted,
 * or crashed mid-probe. Trusting it anyway is what wedged #1223: `promote.mjs` read
 * `probe_in_flight` and waited out most of its 40-minute budget against a stamp with nothing
 * behind it.
 *
 * Mirrors `cleanupStaleSessions` (`startup/startup-tasks.ts`): both reap persisted state whose
 * owning process cannot possibly still exist in THIS generation. Same idempotent shape.
 */
export async function reapStaleBaseHealthProbeStamps(database: Database = db): Promise<string[]> {
  const rows = await getAllPreferences(database);
  const stale = rows.filter(
    (r) => r.key.startsWith(BASE_HEALTH_PROBE_START_PREF_PREFIX) && r.value.trim() !== "",
  );
  for (const row of stale) {
    await setPreference(row.key, "", database);
  }
  return stale.map((r) => r.key);
}
