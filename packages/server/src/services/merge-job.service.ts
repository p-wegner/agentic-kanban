/**
 * In-flight merge tracking, so a merge is observable independently of the HTTP request that
 * started it.
 *
 * The problem this solves: `POST /api/workspaces/:id/merge` runs the pre-merge gate inline,
 * which on a full-suite-plus-build project is 30-45 minutes. The caller had to hold one HTTP
 * connection open for the whole thing, and there was no other way to ask "how did that go?".
 * Any client timeout, proxy hiccup, or `tsx watch` reload therefore produced an outcome that
 * was indistinguishable from a silent failure — the merge might have passed, failed, or still
 * be running, and nothing on the server could tell you which. (Observed repeatedly: three
 * abandoned merge attempts that were each actually running the gate, plus a real
 * `pre_merge_gate_failed` that only surfaced on the fourth try.)
 *
 * Every merge now records its lifecycle here regardless of how it was invoked, so:
 *  - a caller that disconnects can poll `GET /api/workspaces/:id/merge-status` for the verdict;
 *  - a caller that does not want to wait at all can pass `?async=1` and get `202 + jobId`.
 *
 * Deliberately in-memory and per-workspace: this is diagnostic state about a live operation,
 * not a durable record (the durable record is `workspaces.mergedAt` / the issue comment a gate
 * failure writes). Bounded by `MAX_FINISHED_JOBS` so a long-lived server cannot accumulate them.
 *
 * **#945 — "a server restart legitimately forgets it" was true of the JOB and wrong about the
 * WORKSPACE.** Observed live on #919: a ~15-minute gate, a `tsx watch` reload mid-gate, and
 * afterwards `merge-status` returned `{"job": null}` while the workspace sat `readyForMerge:
 * true`, `status: idle`, `mergedAt: null`. The claim above holds — the merge really did die
 * with the process — but nothing else recorded that it had ever been attempted, so the
 * workspace read as armed-and-healthy to every consumer including the monitor and sat
 * indefinitely. Distinct from a gate that FAILS, which records a reason and is actionable.
 *
 * So a job now ALSO writes a one-row durable marker (`workspace_merge_run`) for as long as it
 * is running, cleared on every terminal transition. The rich record stays here and stays
 * forgettable; the marker exists solely so the next process can see that a merge was in flight
 * and say so — `startup/merge-run-reconciler.ts` is the reader. Marker writes are
 * fire-and-forget and non-fatal by construction: a DB hiccup must never fail a merge, and the
 * worst case of a lost write is exactly today's behaviour.
 */

import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { clearMergeRunMarker, resetMergeRunMarkerPort, writeMergeRunMarker } from "./merge-run-marker-port.js";
import { notifySummaryWriteThrough } from "./summary-write-through-notifier.js";

// The durable-marker port moved out to its own module when #944's cache hooks pushed this file
// past the god-module gate (#889). Re-exported so `setMergeRunMarkerPort`'s existing import path
// — the composition root and the #945 tests — keeps working.
export { setMergeRunMarkerPort, type MergeRunMarkerPort } from "./merge-run-marker-port.js";

export type MergeJobState = "running" | "succeeded" | "failed";

/**
 * One GATE ATTEMPT inside a merge job (#936).
 *
 * A single merge job can run the verify gate MORE THAN ONCE — the pre-lock gate can pass and
 * then have its evidence rejected under the lock (a tip moved, or the lock wait outlived
 * `MERGE_GATE_EVIDENCE_MAX_AGE_MS`), the install/flake retry strategies re-run it, and a
 * monitor retry joins the same job. Measured on #926: 3h44m and TWO complete 20-minute suite
 * runs to land a one-commit branch, with `merge-status` reading a bare `{"state":"running"}`
 * for the whole time. An operator watching that cannot tell a slow convergent merge from a
 * hung one — which is exactly the wrong conclusion #936 was originally filed on.
 *
 * So every gate run records itself here: when it started, when it ended, whether it passed,
 * and — the part that was missing entirely — WHY a completed gate did not proceed to the
 * merge.
 */
export interface MergeJobAttempt {
  /** 1-based attempt number within this job. */
  attempt: number;
  /** Which path ran the gate (`pre-lock-merge`, `monitor-auto-merge`, …). */
  source: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  /** Terminal verdict of this attempt, absent while it is still running. */
  outcome?: "passed" | "failed" | "skipped" | "discarded";
  /**
   * Why this attempt did not land the merge, in operator words. Set for `failed` (the gate
   * message) and for `discarded` — the case #936 exists for: the gate ran to completion and
   * its verdict went nowhere (a tip moved during the run, evidence expired before the lock).
   */
  detail?: string;
  /** The gate stage this attempt reached (`verify` / `smoke` / `none`). */
  stage?: string;
}

export interface MergeJob {
  jobId: string;
  workspaceId: string;
  state: MergeJobState;
  startedAt: string;
  finishedAt?: string;
  /** Milliseconds from start to finish — the number that tells you the gate cost. */
  durationMs?: number;
  /** The merge service's result payload, on success. */
  result?: unknown;
  /** Failure message, on failure. */
  error?: string;
  /** Machine-readable failure reason when the merge service supplied one (e.g. `pre_merge_gate_failed`). */
  reason?: string;
  /** Every gate attempt this job has made, oldest first (#936). */
  attempts: MergeJobAttempt[];
  /** `attempts.length`, denormalised so a caller can read the count without walking the list. */
  attemptCount: number;
  /**
   * Last time this job was observed to be DOING something — a gate attempt starting or
   * finishing (#936). This, not `startedAt`, is what the zombie detector measures: a job on
   * its third healthy 20-minute gate attempt is not stuck, it is working.
   */
  lastActivityAt: string;
}

/** How many finished jobs to retain before evicting the oldest. */
const MAX_FINISHED_JOBS = 50;

/**
 * How long a job may sit `"running"` **with no observed activity** before it is treated as a
 * ZOMBIE (#903) — its verify children died (or the process wedged) without the merge code path
 * ever reaching a `completeMergeJob`/`failMergeJob` call. Measured live: a merge job's children
 * exited, the job stayed `"running"` forever, and `mergeWorkspaceDeduped`'s in-memory dedupe map
 * made every retry join the same dead promise — only a backend restart cleared it.
 *
 * Set comfortably above the largest legitimate gate: `MAX_TIMEOUT_MS` in
 * `pre-merge-gate.service.ts` bounds a single verify run at 3h, and a chain can retry once
 * (install) plus a targeted flake re-run — so a genuinely still-running (not zombied) job can
 * legitimately take multiple hours. This is a BACKSTOP for the case where the process running
 * the chain died outright (no timeout ever fires because nothing is left to fire it), not a
 * tighter budget than the gate's own timeouts.
 *
 * **#936 — this is a LIVENESS bound, measured from {@link MergeJob.lastActivityAt}, not from
 * `startedAt`.** It used to be total elapsed time, and that was structurally wrong for a job
 * that silently retries: the clock counted from the FIRST attempt and no retry ever reset it,
 * so a merge needing more than ~12 attempts-worth of wall time was GUARANTEED to be declared
 * dead mid-flight no matter how healthy it was. Observed on #922: the verdict landed at exactly
 * 4h01m while attempt 3's gate process tree was still alive and working, so "no completion" was
 * simply false — and whatever that attempt concluded then had a terminal job to land in.
 * Measuring the gap since the last attempt boundary keeps the backstop's real purpose (nothing
 * is left to fire a timeout) while never firing against a job that is visibly progressing.
 */
export const MERGE_JOB_ZOMBIE_AFTER_MS = 4 * 60 * 60 * 1000;

const jobsByWorkspace = new Map<string, MergeJob>();
/** Insertion order of FINISHED jobs, for bounded eviction. Running jobs are never evicted. */
const finishedOrder: string[] = [];

let counter = 0;

function nextJobId(workspaceId: string): string {
  counter += 1;
  return `merge-${workspaceId.slice(0, 8)}-${counter}`;
}

function evictIfNeeded(): void {
  while (finishedOrder.length > MAX_FINISHED_JOBS) {
    const oldest = finishedOrder.shift();
    if (!oldest) break;
    const job = jobsByWorkspace.get(oldest);
    // Never evict a job that has since been replaced by a running one.
    if (job && job.state !== "running") jobsByWorkspace.delete(oldest);
  }
}

/**
 * Bump the board's cache generation because this workspace's {@link GateActivity} just changed
 * (#944).
 *
 * Since #944 the board card renders `gateActivity`, which is derived from THIS map and from
 * nothing else — no DB row moves between a merge starting and finishing (there is no `merging`
 * workspace status), and no `boardEvents.broadcast()` fires either. So without this call the
 * merge lifecycle is entirely outside the invalidation graph, and
 * `boardEtagCache.tryServe` answers a conditional GET with a 304 — WITHOUT rebuilding the board
 * — for as long as the generation is unchanged, up to its 15-minute hard cap. On an otherwise
 * quiet board that means a merge starts and every card keeps the pre-merge `idle` dot for
 * minutes: precisely the "working hard looks identical to abandoned" confusion #944 exists to
 * remove, reintroduced one layer down.
 *
 * This is the same seam and the same failure mode G13 built the notifier for — a board-visible
 * value mutated outside `boardEvents`. It debounces (500ms) and is best-effort, which is the
 * right weight for a display field.
 */
function notifyGateActivityChanged(workspaceId: string): void {
  notifySummaryWriteThrough(workspaceId);
}

/**
 * Record that a merge has started for this workspace, replacing any previous record.
 *
 * `source` names the path that submitted it (`merge-endpoint`, `monitor-auto-merge`, …). It is
 * only carried on the durable marker: the in-memory job already exposes per-attempt sources,
 * but a recovered marker is all a later process has, and "who asked for this merge" is the
 * first thing an operator reading a restart-interrupted attempt needs.
 */
export function startMergeJob(
  workspaceId: string,
  nowIso = new Date().toISOString(),
  source = "merge-endpoint",
): MergeJob {
  const job: MergeJob = {
    jobId: nextJobId(workspaceId),
    workspaceId,
    state: "running",
    startedAt: nowIso,
    attempts: [],
    attemptCount: 0,
    lastActivityAt: nowIso,
  };
  jobsByWorkspace.set(workspaceId, job);
  // null -> "merging": the card's biggest single change, and the one nothing else announces.
  notifyGateActivityChanged(workspaceId);
  writeMergeRunMarker(workspaceId, { jobId: job.jobId, startedAt: nowIso, source });
  return job;
}

/**
 * Handle identifying one in-flight gate attempt (#936).
 *
 * It carries the `jobId`, not just the attempt number, for the same reason {@link finish} takes
 * one: a gate run is 20-40 MINUTES, and nothing stops the job it started under finishing and
 * being replaced by a fresh job for the same workspace before it returns. Attempt numbers
 * restart at 1 per job, so a bare number would make the late finisher write its verdict into
 * the NEW job's attempt 1 — inventing a completed attempt that job never made and, worse,
 * stamping its `lastActivityAt`, which is exactly the liveness signal the zombie detector
 * trusts. The job id makes that stale write a no-op.
 */
export interface MergeGateAttemptHandle {
  jobId: string;
  attempt: number;
}

/**
 * Record that a gate attempt has STARTED for this workspace's running merge job (#936), and
 * return a handle so the finisher can address it. Returns null when no running job is tracked
 * — a gate can legitimately run outside a merge job (the monitor's own cycle gate, a
 * review-exit gate), and that must be a no-op rather than an error.
 *
 * Doubles as the liveness heartbeat the zombie detector reads: an attempt boundary is the one
 * moment a merge is unambiguously observed to be progressing.
 */
export function noteMergeGateAttemptStarted(
  workspaceId: string,
  source: string,
  nowIso = new Date().toISOString(),
): MergeGateAttemptHandle | null {
  const job = jobsByWorkspace.get(workspaceId);
  if (!job || job.state !== "running") return null;
  const attempt: MergeJobAttempt = { attempt: job.attempts.length + 1, source, startedAt: nowIso };
  job.attempts.push(attempt);
  job.attemptCount = job.attempts.length;
  job.lastActivityAt = nowIso;
  // "merging"/"stalled" -> "verifying", and the attempt number in the label.
  notifyGateActivityChanged(workspaceId);
  return { jobId: job.jobId, attempt: attempt.attempt };
}

/**
 * Record how a gate attempt ENDED (#936). `outcome: "discarded"` is the case this ticket
 * exists for — a gate that ran to completion and whose verdict then went nowhere; `detail`
 * must say why, because that reason was previously in nobody's reach but the OS process tree.
 *
 * A handle whose job has since been replaced is DROPPED, not applied to the successor — see
 * {@link MergeGateAttemptHandle}.
 */
export function noteMergeGateAttemptFinished(
  workspaceId: string,
  handle: MergeGateAttemptHandle | null,
  patch: { outcome: MergeJobAttempt["outcome"]; detail?: string; stage?: string },
  nowIso = new Date().toISOString(),
): void {
  if (handle === null) return;
  const job = jobsByWorkspace.get(workspaceId);
  if (!job || job.jobId !== handle.jobId) return;
  const attempt = job.attempts.find((a) => a.attempt === handle.attempt);
  if (!attempt || attempt.finishedAt) return;
  attempt.finishedAt = nowIso;
  attempt.durationMs = Date.parse(nowIso) - Date.parse(attempt.startedAt);
  attempt.outcome = patch.outcome;
  if (patch.detail) attempt.detail = patch.detail;
  if (patch.stage) attempt.stage = patch.stage;
  job.lastActivityAt = nowIso;
  // "verifying" -> "merging", and a discarded/failed attempt's reason enters the tooltip.
  notifyGateActivityChanged(workspaceId);
}

function finish(jobId: string, workspaceId: string, patch: Partial<MergeJob>): void {
  const job = jobsByWorkspace.get(workspaceId);
  // A newer merge may already have replaced this one; don't clobber its state.
  if (!job || job.jobId !== jobId) return;
  const finishedAt = new Date().toISOString();
  Object.assign(job, patch, {
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(job.startedAt),
    lastActivityAt: finishedAt,
  });
  // Dedupe by workspaceId: `jobsByWorkspace` holds at most ONE entry per workspace, so a
  // workspace merged twice used to leave two `finishedOrder` entries pointing at the same map
  // key. When the OLDER duplicate shifted out at the cap, the eviction deleted the entry holding
  // the NEWER finished job — losing a verdict a caller was still polling for, while the retained
  // duplicate then evicted nothing. Keep one entry per workspace, at its most recent position.
  const previous = finishedOrder.indexOf(workspaceId);
  if (previous !== -1) finishedOrder.splice(previous, 1);
  finishedOrder.push(workspaceId);
  evictIfNeeded();
  // running -> finished, i.e. `gateActivity` goes back to null and the badge must DISAPPEAR.
  // A successful merge broadcasts on its own afterwards, but a failed one does not reliably
  // (the HTTP path's failure branch broadcasts nothing), which would leave a "Verifying" badge
  // on a merge that stopped — the one lie worse than the amber dot #944 replaced.
  notifyGateActivityChanged(workspaceId);
  // #945 — this is the ONE funnel every terminal transition goes through (complete, fail, and
  // the zombie self-heal in `getMergeJob`), so clearing here is what makes "a surviving marker
  // means the runner died" true by construction. Clearing at each call site instead would leave
  // whichever path someone forgot to update writing false orphans forever.
  clearMergeRunMarker(workspaceId);
}

/** Mark a merge job succeeded, retaining its result for later polling. */
export function completeMergeJob(jobId: string, workspaceId: string, result: unknown): void {
  finish(jobId, workspaceId, { state: "succeeded", result });
}

/** Mark a merge job failed, retaining the message/reason for later polling. */
export function failMergeJob(jobId: string, workspaceId: string, error: unknown): void {
  const message = errorMessage(error);
  const reason =
    error && typeof error === "object" && "details" in error
      ? (error as { details?: { mergeReason?: string } }).details?.mergeReason
      : undefined;
  finish(jobId, workspaceId, { state: "failed", error: message, reason });
}

/**
 * Run a merge under a tracked job — the join-or-own protocol, in ONE place (#945).
 *
 * Two callers merge: `POST /:id/merge` and the monitor's auto-merge action. The route grew the
 * protocol first (#903) and the monitor had NONE of it — it called `mergeWorkspaceDeduped`
 * directly, so a monitor-driven merge lost to a restart was as invisible as the HTTP one, and
 * on a hands-off board that is the more common case since the monitor is precisely what "sees
 * the workspace as ready".
 *
 * Three rules, and each exists because getting it wrong has already cost something:
 *  - **JOIN a running job rather than replacing it (#903).** A fresh `startMergeJob` on every
 *    retry resets `startedAt`, so the zombie clock can never elapse against one start time.
 *  - **Only the OWNER may transition it.** A joiner that completed/failed the job would close a
 *    merge another caller is still running, and stamp a verdict that caller never reached.
 *  - **Rethrow unchanged.** Both callers' failure handling reads the error (fix-and-merge
 *    routing, the #638 gate-failure exclusion); wrapping it would break both.
 *
 * The route does NOT use this, deliberately: it additionally needs the pre-call zombie read to
 * thread `dropStaleActiveRequest` and it splits sync/`?async=1` around the same promise, so
 * folding it in here would mean this helper carrying two of its caller's concerns.
 */
export async function runUnderMergeJob<T>(
  workspaceId: string,
  source: string,
  run: () => Promise<T>,
): Promise<T> {
  const existing = getMergeJob(workspaceId);
  const joining = existing !== null && existing.state === "running";
  const job = joining ? existing : startMergeJob(workspaceId, undefined, source);
  try {
    const result = await run();
    if (!joining) completeMergeJob(job.jobId, workspaceId, result);
    return result;
  } catch (err) {
    if (!joining) failMergeJob(job.jobId, workspaceId, err);
    throw err;
  }
}

/**
 * Is a verify gate running FOR THIS JOB right now (#936)?
 *
 * The probe takes the job, and that is the whole point. The build semaphore
 * ({@link buildGateBusy}) answers a PROCESS-GLOBAL question — "is any heavyweight
 * build/verify/smoke task running anywhere" — and it is held by every project's gate, by the
 * cold-clone check and by the e2e smoke lane. Consulting it per job would mean that on a board
 * with ten monitor-mode projects gating more or less continuously, a genuinely wedged job could
 * never be zombied at all: some unrelated project's gate is essentially always in flight, so
 * the backstop #903 exists for (the process running the chain died outright, nothing is left to
 * fire a timeout) would never fire again. That is a strictly worse failure than the one #936
 * fixes, because nothing else ever clears a wedged job.
 *
 * The correct per-job signal is already recorded here: an attempt that STARTED and has not
 * finished. That is this job's own gate, not the box's. It cannot outlive the process (the map
 * is in-memory), and combined with the `lastActivityAt` clock below it means a job is declared
 * dead only when it has both been silent for the full threshold AND has no attempt of its own
 * outstanding.
 *
 * Overridable so a test can drive both answers.
 */
function gateIsAliveForJob(job: MergeJob, nowMs: number): boolean {
  // An UNFINISHED attempt is only evidence of life while it is plausibly still running. A gate
  // whose process died mid-attempt never stamps `finishedAt`, so treating "unfinished" as alive
  // unconditionally would grant that job permanent immunity — the exact #903 wedge this
  // backstop exists for, reintroduced through the liveness check. An attempt that has itself
  // been silent for the full threshold is therefore no longer counted as alive.
  return job.attempts.some((a) => {
    if (a.finishedAt) return false;
    const startedMs = Date.parse(a.startedAt);
    if (Number.isNaN(startedMs)) return false;
    return nowMs - startedMs < MERGE_JOB_ZOMBIE_AFTER_MS;
  });
}

let gateIsAlive: (job: MergeJob, nowMs: number) => boolean = gateIsAliveForJob;

/** Test seam: replace the liveness probe the zombie detector consults. */
export function setMergeGateLivenessProbe(probe: (job: MergeJob, nowMs: number) => boolean): void {
  gateIsAlive = probe;
}

/** The moment this job was last observed doing something — an attempt boundary, else its start. */
function lastActivityMs(job: MergeJob): number {
  const parsed = Date.parse(job.lastActivityAt ?? job.startedAt);
  return Number.isNaN(parsed) ? Date.parse(job.startedAt) : parsed;
}

/**
 * True when a `"running"` job has shown NO activity for longer than
 * {@link MERGE_JOB_ZOMBIE_AFTER_MS} (#903, corrected by #936) — its children died without the
 * merge code path ever reaching a `complete`/`failMergeJob` call, so nothing else will ever
 * transition this record.
 *
 * Two things make this a liveness test rather than a stopwatch:
 *  - the clock runs from {@link MergeJob.lastActivityAt}, which every gate attempt boundary
 *    resets, so a job on its Nth healthy attempt is never declared dead for having taken a
 *    long time in total (#936 — that is precisely how #922 was killed mid-gate);
 *  - a job whose gate process tree is CURRENTLY alive is never a zombie at all, whatever the
 *    timestamps say. "No completion" must not be asserted about something visibly working.
 */
export function isZombieMergeJob(job: MergeJob, nowMs: number = Date.now()): boolean {
  if (job.state !== "running") return false;
  const sinceMs = lastActivityMs(job);
  if (Number.isNaN(sinceMs)) return false;
  if (nowMs - sinceMs < MERGE_JOB_ZOMBIE_AFTER_MS) return false;
  // This job's own gate still plausibly in flight ⇒ not a zombie.
  if (gateIsAlive(job, nowMs)) return false;
  return true;
}

/**
 * What the zombie verdict actually OBSERVED (#936). The old message asserted "no completion",
 * which was false for a job that was mid-attempt; this one states the evidence — how long the
 * record has been silent, how many attempts it made, and that no gate process was running.
 */
function describeZombieVerdict(job: MergeJob, nowMs: number): string {
  const quietMin = Math.round((nowMs - lastActivityMs(job)) / 60_000);
  const attempts = job.attemptCount ?? 0;
  const lastAttempt = job.attempts?.[job.attempts.length - 1];
  const attemptNote = attempts === 0
    ? "no gate attempt was ever recorded"
    : `${attempts} gate attempt(s) recorded, the last starting ${lastAttempt?.startedAt}`
      + (lastAttempt?.finishedAt ? ` and finishing ${lastAttempt.finishedAt}` : " and never finishing");
  return `merge job zombied — no gate process is running and nothing has been observed for ${quietMin} minutes `
    + `(threshold ${Math.round(MERGE_JOB_ZOMBIE_AFTER_MS / 60_000)}m); ${attemptNote} (#903/#936)`;
}

/**
 * The latest merge job for a workspace, or null if none is known to this process.
 *
 * Self-heals a ZOMBIE on read (#903): a job stuck `"running"` past
 * {@link MERGE_JOB_ZOMBIE_AFTER_MS} is transitioned to `"failed"` here rather than left for a
 * caller to notice never changes — `getMergeJob` is what the merge-status endpoint (and any
 * future zombie-sweep) both read, so healing it here means every consumer sees the same
 * corrected state without needing its own staleness check.
 */
export function getMergeJob(workspaceId: string, nowMs: number = Date.now()): MergeJob | null {
  const job = jobsByWorkspace.get(workspaceId);
  if (!job) return null;
  if (isZombieMergeJob(job, nowMs)) {
    finish(job.jobId, workspaceId, {
      state: "failed",
      error: describeZombieVerdict(job, nowMs),
      reason: "merge_job_zombied",
    });
    return jobsByWorkspace.get(workspaceId) ?? null;
  }
  return job;
}

/**
 * The tracked job for a workspace WITHOUT the zombie self-heal, for display-only readers (#944).
 *
 * {@link getMergeJob} transitions a zombied job to `failed` as a side effect of reading it,
 * which is right for the merge-status endpoint (a caller polling for a verdict should get the
 * corrected one) and wrong for the board. A board rebuild reads every workspace, runs on a WS
 * broadcast and a 30s poll, and is triggered by any second tab — so routing it through
 * `getMergeJob` would make an incidental card refresh the thing that declares a merge dead,
 * at whatever moment a rebuild happened to land. Failing a merge is a decision, not a render.
 *
 * A display reader can afford the staleness: a zombied job still reads as `running` here, and
 * {@link deriveGateActivity} renders exactly that state as `stalled` — which is the honest
 * report of what this process knows, and the same conclusion, without writing it down.
 */
export function peekMergeJob(workspaceId: string): MergeJob | null {
  return jobsByWorkspace.get(workspaceId) ?? null;
}

/**
 * A one-line, operator-readable account of a merge job's gate attempts (#936).
 *
 * The point is that a long-running merge reads as "gate attempt 2 in flight; attempt 1 passed
 * at 23:21 but was discarded (…)" rather than as an opaque `running` an operator can only
 * distinguish from a hang by watching the OS process tree.
 */
export function describeMergeJobAttempts(job: MergeJob): string {
  const attempts = job.attempts ?? [];
  if (attempts.length === 0) {
    return job.state === "running"
      ? "no gate attempt recorded yet for this merge (it may be resolving conflicts, taking the repo lock, or gating outside this job)"
      : "no gate attempt was recorded for this merge";
  }
  const parts = attempts.map((a) => {
    const head = `attempt ${a.attempt} (${a.source})`;
    if (!a.finishedAt) return `${head}: IN FLIGHT since ${a.startedAt}`;
    const secs = Math.round((a.durationMs ?? 0) / 1000);
    const stage = a.stage ? ` stage ${a.stage},` : "";
    return `${head}: ${a.outcome ?? "unknown"} after ${secs}s (${stage} finished ${a.finishedAt})`
      + (a.detail ? ` — ${a.detail}` : "");
  });
  return `${attempts.length} gate attempt(s). ${parts.join("; ")}`;
}

/** Test seam: drop all tracked jobs, the injected liveness probe and the marker port. */
export function resetMergeJobs(): void {
  jobsByWorkspace.clear();
  finishedOrder.length = 0;
  counter = 0;
  gateIsAlive = gateIsAliveForJob;
  resetMergeRunMarkerPort();
}
