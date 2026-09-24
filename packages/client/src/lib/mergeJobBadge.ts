/**
 * Pure projections of a `GET /merge-status` body for the merge badge and the merge error
 * (#1250). Beside `mergeJobTracker.ts`, which owns the fetching; this file owns no state, so
 * the badge text and the error text are assertable without a DOM.
 */
import type { MergeFixHint } from "@agentic-kanban/shared/types";
import { formatGateDuration } from "@agentic-kanban/shared/lib/gate-activity";

export type { MergeFixHint } from "@agentic-kanban/shared/types";

export interface MergeJobAttemptView {
  attempt: number;
  source?: string;
  startedAt?: string;
  finishedAt?: string;
  outcome?: "passed" | "failed" | "skipped" | "discarded";
  detail?: string;
  phase?: string;
  phaseSince?: string;
  phaseDetail?: string;
}

export interface MergeJobView {
  jobId: string;
  state: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  error?: string;
  attempts?: MergeJobAttemptView[];
}

/** What `GET /api/workspaces/:id/merge-status` answers; the fields the client reads. */
export interface MergeStatusView {
  job: MergeJobView | null;
  attemptSummary?: string;
  /** Present on the absent shape: a merge that landed (or died) while the job map was lost. */
  outcome?: "completed" | "interrupted";
  fixHint?: MergeFixHint | null;
  message?: string;
}

/** The inline merge-error banner state, keyed to the failing workspace. */
export interface MergeErrorState {
  wsId: string;
  message: string;
  /** #1250 — set when the red is a stale shrink-only baseline; drives "Bank shrinks and retry". */
  fixHint?: MergeFixHint | null;
}

export interface MergeJobBadge {
  /** `Merging · verify · 3m12s · attempt 1` */
  label: string;
  /** The phase detail (what the queue waits behind, …) plus the attempt summary, for the tooltip. */
  title: string;
}

/** How many characters of a failed attempt's detail the banner keeps — the tail is where the verdict is. */
const ERROR_TAIL_CHARS = 1200;

/**
 * The badge for a RUNNING job, or null when there is nothing in flight. Elapsed counts from
 * the in-flight attempt's `phaseSince` (a gate queued for 40 min and verifying for 2 reads
 * `verify · 2m`), from the attempt start before the first phase, from the job start before
 * the first attempt.
 */
export function describeMergeJobBadge(status: MergeStatusView | null, nowMs: number = Date.now()): MergeJobBadge | null {
  const job = status?.job;
  if (!job || job.state !== "running") return null;
  const attempts = job.attempts ?? [];
  const inFlight = attempts.find((a) => !a.finishedAt) ?? null;
  const since = inFlight?.phaseSince ?? inFlight?.startedAt ?? job.startedAt;
  const sinceMs = Date.parse(since);
  const elapsed = formatGateDuration(Number.isNaN(sinceMs) ? 0 : Math.max(0, nowMs - sinceMs));
  const phase = inFlight?.phase ?? (inFlight ? "gate" : "starting");
  const attemptNo = inFlight?.attempt ?? attempts.length;
  const label = `Merging · ${phase} · ${elapsed}` + (attemptNo > 0 ? ` · attempt ${attemptNo}` : "");
  const title = [inFlight?.phaseDetail, status?.attemptSummary].filter((s): s is string => !!s).join("\n");
  return { label, title: title || "The pre-merge gate is running; this badge polls its status every few seconds." };
}

function tail(text: string): string {
  return text.length > ERROR_TAIL_CHARS ? `…${text.slice(-ERROR_TAIL_CHARS)}` : text;
}

/**
 * The merge-error banner for a FAILED (or cancelled) job: the last attempt's detail tail —
 * which already ends with the fix line when the gate derived one — plus the parsed hint so the
 * banner can offer "Bank shrinks and retry". Null while running or after success.
 */
export function mergeErrorFromStatus(wsId: string, status: MergeStatusView | null): MergeErrorState | null {
  const job = status?.job;
  if (!job || job.state === "running" || job.state === "succeeded") return null;
  const attempts = job.attempts ?? [];
  const last = attempts[attempts.length - 1];
  const message = (last?.outcome === "failed" && last.detail) || job.error || `merge ${job.state}`;
  return { wsId, message: tail(message), fixHint: status?.fixHint ?? null };
}

/** True once a polled status is terminal, i.e. polling may stop. */
export function isTerminalMergeStatus(status: MergeStatusView | null): boolean {
  if (!status) return false;
  if (status.job) return status.job.state !== "running";
  // The absent shape: the job map was lost. `completed`/`interrupted` are answers; anything
  // else means this process never saw the job, which polling will not change either.
  return true;
}
