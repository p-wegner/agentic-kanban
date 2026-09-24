/**
 * The client's record of merges IN FLIGHT (#1250).
 *
 * `POST /api/workspaces/:id/merge` used to be awaited SYNCHRONOUSLY for the whole pre-merge
 * gate (8-45 minutes). A dropped request looked like a no-op — the route dedupes and keeps the
 * job (#903), so the operator on #1243 pressed Merge three times and saw nothing while
 * `GET /merge-status` had the attempt and phase all along. Every merge door now posts
 * `?async=1` (202 + jobId) through {@link startAsyncMerge} and this module polls the status
 * until it is terminal, so the card can show `Merging · verify · 3m12s · attempt 1` whichever
 * button started it — the keyboard shortcut, the merge queue, the repo strip or the card.
 *
 * A module-level store rather than component state, on purpose: the poll must outlive the
 * panel that started it (the queue panel closes; the card is not mounted for every workspace),
 * and a second click on a running merge must be recognisable as "joining" without a network
 * round trip. Components subscribe through `useMergeJobStatus` (`useSyncExternalStore`).
 *
 * Polling goes through `startStaggeredPoll`, the one sanctioned scheduler (visibility-gated,
 * phase-staggered — see `lib/pollScheduler.ts`), one timer per tracked workspace.
 */
import { apiFetch, apiPost } from "./api.js";
import { startStaggeredPoll, type PollHandle } from "./pollScheduler.js";
import {
  isTerminalMergeStatus,
  mergeErrorFromStatus,
  type MergeErrorState,
  type MergeStatusView,
} from "./mergeJobBadge.js";

/** How often a tracked merge asks for its status. The gate reports phases at this grain. */
export const MERGE_STATUS_POLL_MS = 5_000;

export interface MergeJobHandlers {
  /** The job reached `failed`/`cancelled`, or the server lost it mid-flight. */
  onFailed?: (error: MergeErrorState) => void;
  /** The job reached `succeeded` (or the absent shape says the merge is stamped). */
  onSucceeded?: () => void;
}

export interface TrackedMergeJob {
  wsId: string;
  jobId: string | null;
  startedAt: number;
  /** The last polled status; null until the first poll answers. */
  status: MergeStatusView | null;
}

interface Entry extends TrackedMergeJob {
  handlers: MergeJobHandlers;
  poll: PollHandle | null;
  inFlight: boolean;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
/** The snapshot handed to `useSyncExternalStore`; replaced (never mutated) on every change. */
let snapshot: ReadonlyMap<string, TrackedMergeJob> = new Map();

function publish(): void {
  snapshot = new Map([...entries].map(([id, e]) => [id, { wsId: e.wsId, jobId: e.jobId, startedAt: e.startedAt, status: e.status }]));
  for (const fn of listeners) fn();
}

export function subscribeMergeJobs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getMergeJobsSnapshot(): ReadonlyMap<string, TrackedMergeJob> {
  return snapshot;
}

/** Is a merge for this workspace being tracked right now (running, as far as the client knows)? */
export function isMergeTracked(wsId: string): boolean {
  return entries.has(wsId);
}

function finish(entry: Entry, status: MergeStatusView): void {
  entry.poll?.stop();
  entries.delete(entry.wsId);
  publish();
  const job = status.job;
  const succeeded = job ? job.state === "succeeded" : status.outcome === "completed";
  if (succeeded) {
    entry.handlers.onSucceeded?.();
    return;
  }
  const error = mergeErrorFromStatus(entry.wsId, status) ?? {
    wsId: entry.wsId,
    message: status.message ?? "the server no longer holds this merge job; check the merge status",
    fixHint: status.fixHint ?? null,
  };
  entry.handlers.onFailed?.(error);
}

/**
 * One poll tick. Exported for the tests (which drive it directly instead of a timer) and for a
 * caller that wants a status now rather than at the next tick.
 */
export async function pollMergeStatus(wsId: string): Promise<void> {
  const entry = entries.get(wsId);
  if (!entry || entry.inFlight) return;
  entry.inFlight = true;
  try {
    const status = await apiFetch<MergeStatusView>(`/api/workspaces/${wsId}/merge-status`);
    if (entries.get(wsId) !== entry) return;
    entry.status = status;
    if (status.job?.jobId) entry.jobId = status.job.jobId;
    if (isTerminalMergeStatus(status)) finish(entry, status);
    else publish();
  } catch {
    // A transient error keeps whatever we last saw; the next tick asks again.
  } finally {
    entry.inFlight = false;
  }
}

function track(wsId: string, jobId: string | null, handlers: MergeJobHandlers): Entry {
  const existing = entries.get(wsId);
  if (existing) {
    existing.handlers = handlers;
    if (jobId) existing.jobId = jobId;
    return existing;
  }
  const entry: Entry = { wsId, jobId, startedAt: Date.now(), status: null, handlers, poll: null, inFlight: false };
  entries.set(wsId, entry);
  entry.poll = startStaggeredPoll(() => { void pollMergeStatus(wsId); }, MERGE_STATUS_POLL_MS);
  publish();
  void pollMergeStatus(wsId);
  return entry;
}

export interface StartAsyncMergeResult {
  /** True when a merge for this workspace was already tracked: no POST was sent. */
  joined: boolean;
  jobId: string | null;
}

/**
 * Start (or join) a merge for `wsId`: `POST /merge?async=1`, then poll `/merge-status` every
 * {@link MERGE_STATUS_POLL_MS} until the job is terminal, calling the handlers once.
 *
 * A second call while the first is tracked replaces the handlers and sends nothing — the
 * route would join the running job anyway (#903), and the caller learns `joined: true` so it
 * can say "joining the running merge" instead of "merge started". A POST that fails throws
 * before anything is tracked.
 */
export async function startAsyncMerge(wsId: string, handlers: MergeJobHandlers = {}): Promise<StartAsyncMergeResult> {
  if (entries.has(wsId)) {
    track(wsId, null, handlers);
    return { joined: true, jobId: entries.get(wsId)?.jobId ?? null };
  }
  const accepted = await apiPost<{ accepted: true; jobId: string }>(`/api/workspaces/${wsId}/merge?async=1`, {});
  track(wsId, accepted.jobId, handlers);
  return { joined: false, jobId: accepted.jobId };
}

/**
 * `POST /merge/bank-shrinks` (#1250): commit the stale-baseline edits the last failed gate
 * named and re-trigger the merge, tracked exactly like {@link startAsyncMerge}. Throws when
 * the server refuses (409 while a merge runs, 422 with no hint or a dirty tree).
 */
export async function bankShrinksAndRetry(wsId: string, handlers: MergeJobHandlers = {}): Promise<{ jobId: string; committed: string }> {
  const result = await apiPost<{ jobId: string; committed: string }>(`/api/workspaces/${wsId}/merge/bank-shrinks`, {});
  track(wsId, result.jobId, handlers);
  return { jobId: result.jobId, committed: result.committed };
}

/**
 * The handlers a merge DOOR passes: show the failure where merge errors already render, and
 * refetch on success exactly as the synchronous path did. One helper so the card, the action
 * bar and "Bank shrinks and retry" cannot disagree about what a terminal merge does.
 */
export function mergeDoorHandlers(deps: {
  setMergeError: (error: MergeErrorState | null) => void;
  setError?: (message: string | null) => void;
  refetch: () => void;
}): MergeJobHandlers {
  return {
    onFailed: (error) => {
      deps.setError?.(error.message);
      deps.setMergeError(error);
    },
    onSucceeded: () => deps.refetch(),
  };
}

/** Test seam: drop every tracked merge and stop its timer. */
export function resetMergeJobTracker(): void {
  for (const entry of entries.values()) entry.poll?.stop();
  entries.clear();
  publish();
}
