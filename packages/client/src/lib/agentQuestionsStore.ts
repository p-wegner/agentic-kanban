/**
 * Shared fetcher for GET /api/projects/:id/agent-questions.
 *
 * The endpoint is the server's most expensive poll target (~450-850ms measured),
 * and three independent consumers hit it — the always-mounted badge hook
 * (useAgentQuestionsCount), the AgentQuestionsPanel (Butler view), and the
 * SpecPhasePanel's embedded panel — producing observed 4-calls-in-3s bursts.
 *
 * This module collapses those into one request via a module-level per-project
 * cache with in-flight dedupe. The TTL is a short safety net only; mutations
 * (answer/dismiss) must call invalidateAgentQuestions() so the next read is
 * fresh — correctness beats hit rate.
 */
import { apiFetch } from "./api.js";
import type { PendingQuestionSet } from "../components/AgentQuestionsPanel.js";

interface CacheEntry {
  data: PendingQuestionSet[] | null;
  fetchedAt: number;
  inFlight: Promise<PendingQuestionSet[]> | null;
}

/** Short cache so near-simultaneous pollers share one result. */
const CACHE_TTL_MS = 5_000;

const cache = new Map<string, CacheEntry>();

/** Drop cached questions for one project (or all). Call after any mutation. */
export function invalidateAgentQuestions(projectId?: string): void {
  if (projectId !== undefined) cache.delete(projectId);
  else cache.clear();
}

/**
 * Fetch the pending agent questions for a project, deduping concurrent calls
 * and serving results younger than CACHE_TTL_MS. `force` bypasses the TTL
 * (it still piggybacks on an already in-flight request).
 */
export function getAgentQuestions(
  projectId: string,
  opts: { force?: boolean } = {},
): Promise<PendingQuestionSet[]> {
  let entry = cache.get(projectId);
  if (!entry) {
    entry = { data: null, fetchedAt: 0, inFlight: null };
    cache.set(projectId, entry);
  }
  if (entry.inFlight) return entry.inFlight;
  if (!opts.force && entry.data !== null && Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
    return Promise.resolve(entry.data);
  }
  const target = entry;
  const request = apiFetch<{ questions: PendingQuestionSet[] }>(
    `/api/projects/${projectId}/agent-questions`,
  )
    .then((res) => {
      target.data = res.questions;
      target.fetchedAt = Date.now();
      target.inFlight = null;
      return res.questions;
    })
    .catch((err: unknown) => {
      target.inFlight = null;
      throw err;
    });
  target.inFlight = request;
  return request;
}
