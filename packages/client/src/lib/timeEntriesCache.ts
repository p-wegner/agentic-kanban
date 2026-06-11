import { apiFetch } from "./api.js";

/**
 * Module-level cache for GET /api/issues/:id/time-entries.
 *
 * Why: every rendered IssueCard mounts an IssueWorkLogBadge that used to fire
 * its own fetch in a bare useEffect — doubled by React StrictMode's dev
 * double-mount, that was ~10 requests per board load for 5 visible cards and
 * up to ~100 with the backlog rail open, almost all returning empty results.
 *
 * Mechanism:
 * - in-flight promise map keyed by issueId — concurrent callers (incl. the
 *   StrictMode double-mount) share one request;
 * - result cache with a short TTL (~60s) — covers remounts and board
 *   refetches without re-hitting the endpoint; empty results ({entries: [],
 *   totalMinutes: 0}) are cached the same way, acting as the negative cache;
 * - errors are NOT cached — the next consumer retries.
 *
 * Invalidation: callers that mutate time entries (POST/DELETE) should call
 * invalidateTimeEntries(issueId) so the badge picks up the change on next
 * mount; the TTL is the safety net, not the primary mechanism.
 */

export interface TimeEntriesResponse {
  entries: unknown[];
  totalMinutes: number;
}

const TTL_MS = 60_000;

const inFlight = new Map<string, Promise<TimeEntriesResponse>>();
const results = new Map<string, { value: TimeEntriesResponse; at: number }>();

export function getIssueTimeEntries(issueId: string): Promise<TimeEntriesResponse> {
  const cached = results.get(issueId);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return Promise.resolve(cached.value);
  }
  const pending = inFlight.get(issueId);
  if (pending) return pending;

  const promise = apiFetch<TimeEntriesResponse>(`/api/issues/${issueId}/time-entries`)
    .then((data) => {
      results.set(issueId, { value: data, at: Date.now() });
      return data;
    })
    .finally(() => {
      inFlight.delete(issueId);
    });
  inFlight.set(issueId, promise);
  return promise;
}

/** Drop cached results for one issue (or all issues when omitted). */
export function invalidateTimeEntries(issueId?: string): void {
  if (issueId !== undefined) {
    results.delete(issueId);
    inFlight.delete(issueId);
  } else {
    results.clear();
    inFlight.clear();
  }
}
