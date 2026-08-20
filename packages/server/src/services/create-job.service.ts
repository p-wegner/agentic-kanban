/**
 * In-flight workspace-CREATION tracking, so a create is observable independently of the
 * HTTP request that started it (#269) — the same shape as merge-job.service.ts (#578).
 *
 * The problem this solves: `POST /api/workspaces` runs the whole worktree provisioning
 * pipeline inline — worktree + branch creation, per-worktree dependency install
 * (setup script), sibling-repo worktrees, and the context packer. Measured live that
 * was 8+ minutes (worktree-setup=294s, context-packer=67s, total=514s), so every
 * caller blocked for the duration: the UI launch form, `pnpm cli`, MCP
 * `start_workspace`, and — worst — the monitor auto-start loop, whose whole cycle
 * stalled ~8min per launch. HTTP clients with sane timeouts reported failure for
 * launches that actually succeeded.
 *
 * `?async=1` on POST /api/workspaces records the creation here and returns
 * `202 + jobId` immediately; the verdict (the full CreateWorkspaceResult, or the
 * failure) is pollable via `GET /api/workspaces/create-jobs/:jobId`.
 *
 * Deliberately in-memory: this is diagnostic state about a live operation, not a
 * durable record (the durable record is the workspace row itself, which the create
 * writes). A server restart legitimately forgets it — the create died with the
 * process too. Bounded by `MAX_FINISHED_JOBS` so a long-lived server cannot
 * accumulate them.
 */

import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

export type CreateJobState = "running" | "succeeded" | "failed";

export interface CreateJob {
  jobId: string;
  issueId: string;
  state: CreateJobState;
  startedAt: string;
  finishedAt?: string;
  /** Milliseconds from start to finish — the number that tells you the provisioning cost. */
  durationMs?: number;
  /**
   * The create service's result payload (the workspace row, same shape a synchronous
   * 201 would have returned). Present on `succeeded`, and also on `failed` when the
   * service returned an error-status result instead of throwing — its `error` field
   * carries the message, and its `id` may reference a row that was never inserted.
   */
  result?: unknown;
  /** The created workspace's id, when known (convenience — also inside `result`). */
  workspaceId?: string;
  /** Failure message, on failure. */
  error?: string;
}

/** How many finished jobs to retain before evicting the oldest. */
const MAX_FINISHED_JOBS = 50;

const jobsById = new Map<string, CreateJob>();
/** Insertion order of FINISHED jobs, for bounded eviction. Running jobs are never evicted. */
const finishedOrder: string[] = [];

let counter = 0;

function nextJobId(issueId: string): string {
  counter += 1;
  return `create-${issueId.slice(0, 8)}-${counter}`;
}

function evictIfNeeded(): void {
  while (finishedOrder.length > MAX_FINISHED_JOBS) {
    const oldest = finishedOrder.shift();
    if (!oldest) break;
    const job = jobsById.get(oldest);
    if (job && job.state !== "running") jobsById.delete(oldest);
  }
}

/** Record that a workspace creation has started for this issue. */
export function startCreateJob(issueId: string, nowIso = new Date().toISOString()): CreateJob {
  const job: CreateJob = {
    jobId: nextJobId(issueId),
    issueId,
    state: "running",
    startedAt: nowIso,
  };
  jobsById.set(job.jobId, job);
  return job;
}

function finish(jobId: string, patch: Partial<CreateJob>): void {
  const job = jobsById.get(jobId);
  if (!job || job.state !== "running") return;
  const finishedAt = new Date().toISOString();
  Object.assign(job, patch, {
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(job.startedAt),
  });
  finishedOrder.push(jobId);
  evictIfNeeded();
}

/**
 * Record the create service's resolved result. createWorkspace reports most failures by
 * RESOLVING with `status: "error"` + `error` (only WorkspaceErrors throw), so this maps
 * an error-status result to a `failed` job — a poller must not read a resolved promise
 * as success the way a naive `.then` would.
 */
export function completeCreateJob(jobId: string, result: { id?: string; status?: string; error?: string }): void {
  const failed = result?.status === "error";
  finish(jobId, {
    state: failed ? "failed" : "succeeded",
    result,
    workspaceId: typeof result?.id === "string" ? result.id : undefined,
    error: failed ? (result?.error ?? "workspace creation failed") : undefined,
  });
}

/** Mark a create job failed from a thrown error (WorkspaceError path). */
export function failCreateJob(jobId: string, error: unknown): void {
  const message = errorMessage(error);
  finish(jobId, { state: "failed", error: message });
}

/** The create job with this id, or null if none is known to this process. */
export function getCreateJob(jobId: string): CreateJob | null {
  return jobsById.get(jobId) ?? null;
}

/**
 * The newest RUNNING create job for this issue, or null (#357/#360).
 *
 * Why this read exists: provisioning is 80s to 8+ minutes, and for that whole window the
 * workspace ROW does not exist yet (the insert and the issue's move to In Progress are one
 * transaction at the END of provisioning). So "no workspace row" is ambiguous between "a launch
 * is in flight" and "nothing will ever start" — and the butler's post-approval message got that
 * distinction exactly backwards on 2 of 3 live approvals, telling the user nothing was planned
 * while the next step was 80s from having a live workspace. This registry is the only in-process
 * evidence that separates the two.
 */
export function findRunningCreateJobForIssue(issueId: string): CreateJob | null {
  let newest: CreateJob | null = null;
  for (const job of jobsById.values()) {
    if (job.issueId !== issueId || job.state !== "running") continue;
    if (!newest || job.startedAt > newest.startedAt) newest = job;
  }
  return newest;
}

/** Test seam: drop all tracked jobs. */
export function resetCreateJobs(): void {
  jobsById.clear();
  finishedOrder.length = 0;
  counter = 0;
}
