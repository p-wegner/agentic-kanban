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

export type MergeJobState = "running" | "succeeded" | "failed";

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
}

/** How many finished jobs to retain before evicting the oldest. */
const MAX_FINISHED_JOBS = 50;

/**
 * How long a job may sit `"running"` with the record never updated before it is treated as a
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
  };
  jobsByWorkspace.set(workspaceId, job);
  return job;
}

function finish(jobId: string, workspaceId: string, patch: Partial<MergeJob>): void {
  const job = jobsByWorkspace.get(workspaceId);
  // A newer merge may already have replaced this one; don't clobber its state.
  if (!job || job.jobId !== jobId) return;
  const finishedAt = new Date().toISOString();
  Object.assign(job, patch, {
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(job.startedAt),
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
 * True when a `"running"` job has sat that way longer than {@link MERGE_JOB_ZOMBIE_AFTER_MS}
 * (#903) — its children died without the merge code path ever reaching a
 * `complete`/`failMergeJob` call, so nothing else will ever transition this record.
 */
export function isZombieMergeJob(job: MergeJob, nowMs: number = Date.now()): boolean {
  if (job.state !== "running") return false;
  const startedAtMs = Date.parse(job.startedAt);
  if (Number.isNaN(startedAtMs)) return false;
  return nowMs - startedAtMs >= MERGE_JOB_ZOMBIE_AFTER_MS;
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
      error: `merge job zombied — stuck "running" for over ${Math.round(MERGE_JOB_ZOMBIE_AFTER_MS / 60_000)} minutes with no completion (#903)`,
      reason: "merge_job_zombied",
    });
    return jobsByWorkspace.get(workspaceId) ?? null;
  }
  return job;
}

/** Test seam: drop all tracked jobs. */
export function resetMergeJobs(): void {
  jobsByWorkspace.clear();
  finishedOrder.length = 0;
  counter = 0;
}
