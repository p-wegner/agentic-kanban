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
 * failure writes). A server restart legitimately forgets it — the merge died with the process
 * too. Bounded by `MAX_FINISHED_JOBS` so a long-lived server cannot accumulate them.
 */

import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { buildGateBusy } from "./jvm-build-semaphore.js";

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

/** Record that a merge has started for this workspace, replacing any previous record. */
export function startMergeJob(workspaceId: string, nowIso = new Date().toISOString()): MergeJob {
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
  return job;
}

/**
 * Record that a gate attempt has STARTED for this workspace's running merge job (#936), and
 * return its attempt number so the finisher can address it. Returns null when no running job
 * is tracked — a gate can legitimately run outside a merge job (the monitor's own cycle gate,
 * a review-exit gate), and that must be a no-op rather than an error.
 *
 * Doubles as the liveness heartbeat the zombie detector reads: an attempt boundary is the one
 * moment a merge is unambiguously observed to be progressing.
 */
export function noteMergeGateAttemptStarted(
  workspaceId: string,
  source: string,
  nowIso = new Date().toISOString(),
): number | null {
  const job = jobsByWorkspace.get(workspaceId);
  if (!job || job.state !== "running") return null;
  const attempt: MergeJobAttempt = { attempt: job.attempts.length + 1, source, startedAt: nowIso };
  job.attempts.push(attempt);
  job.attemptCount = job.attempts.length;
  job.lastActivityAt = nowIso;
  return attempt.attempt;
}

/**
 * Record how a gate attempt ENDED (#936). `outcome: "discarded"` is the case this ticket
 * exists for — a gate that ran to completion and whose verdict then went nowhere; `detail`
 * must say why, because that reason was previously in nobody's reach but the OS process tree.
 */
export function noteMergeGateAttemptFinished(
  workspaceId: string,
  attemptNumber: number | null,
  patch: { outcome: MergeJobAttempt["outcome"]; detail?: string; stage?: string },
  nowIso = new Date().toISOString(),
): void {
  if (attemptNumber === null) return;
  const job = jobsByWorkspace.get(workspaceId);
  if (!job) return;
  const attempt = job.attempts.find((a) => a.attempt === attemptNumber);
  if (!attempt || attempt.finishedAt) return;
  attempt.finishedAt = nowIso;
  attempt.durationMs = Date.parse(nowIso) - Date.parse(attempt.startedAt);
  attempt.outcome = patch.outcome;
  if (patch.detail) attempt.detail = patch.detail;
  if (patch.stage) attempt.stage = patch.stage;
  job.lastActivityAt = nowIso;
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
 * Is a verify gate running right now (#936)?
 *
 * Defaults to the build semaphore, which is the process's own answer to that question and is
 * free to ask (an integer read, no spawn) — deliberately NOT left to composition-root wiring,
 * because a probe nobody installs silently degrades this back to the stopwatch #936 is about.
 * Overridable so a test can drive both answers.
 */
let gateIsAlive: () => boolean = buildGateBusy;

/** Test seam: replace the liveness probe the zombie detector consults. */
export function setMergeGateLivenessProbe(probe: () => boolean): void {
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
  // Alive gate ⇒ not a zombie, regardless of how long the record has been quiet.
  if (gateIsAlive()) return false;
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

/** Test seam: drop all tracked jobs and the injected liveness probe. */
export function resetMergeJobs(): void {
  jobsByWorkspace.clear();
  finishedOrder.length = 0;
  counter = 0;
  gateIsAlive = buildGateBusy;
}
