/**
 * Shared fetcher for GET /api/projects/:id/agent-questions.
 *
 * The endpoint is the server's most expensive poll target (~450-850ms measured),
 * and three independent consumers hit it — the always-mounted badge hook
 * (useAgentQuestionsCount), the AgentQuestionsPanel (Butler view), and the
 * SpecPhasePanel's embedded panel — producing observed 4-calls-in-3s bursts.
 *
 * This used to be a hand-rolled module cache reimplementing TTL + in-flight
 * dedupe. It now delegates to react-query (the single client data layer):
 * `queryClient.fetchQuery` serves data younger than `staleTime` and collapses
 * concurrent calls into one in-flight request — exactly the behavior the old
 * module cache hand-rolled. Mutations (answer/dismiss) call
 * invalidateAgentQuestions() so the next read is fresh — correctness beats hit
 * rate. See #906.
 */
import { apiFetch } from "./api.js";
import { queryClient } from "./queryClient.js";
import { boardQueryKeys } from "../hooks/useBoardDataQueries.js";
import type { PendingQuestionSet } from "../components/AgentQuestionsPanel.js";

/** Short cache window so near-simultaneous pollers share one result. */
const CACHE_TTL_MS = 5_000;

function fetchAgentQuestions(projectId: string): Promise<PendingQuestionSet[]> {
  return apiFetch<{ questions: PendingQuestionSet[] }>(
    `/api/projects/${projectId}/agent-questions`,
  ).then((res) => res.questions);
}

/** Drop cached questions for one project (or all). Call after any mutation. */
export function invalidateAgentQuestions(projectId?: string): void {
  if (projectId !== undefined) {
    void queryClient.invalidateQueries({ queryKey: boardQueryKeys.agentQuestions(projectId) });
    return;
  }
  // No-project: invalidate every project's agent-questions key without touching
  // other ["projects", ...] queries (board, milestones, …) via a precise predicate.
  void queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey.length === 3 &&
      query.queryKey[0] === "projects" &&
      query.queryKey[2] === "agent-questions",
  });
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
  return queryClient.fetchQuery({
    queryKey: boardQueryKeys.agentQuestions(projectId),
    queryFn: () => fetchAgentQuestions(projectId),
    // staleTime 0 with an in-flight request still dedupes onto that request,
    // so `force` re-fetches without breaking concurrent-caller coalescing.
    staleTime: opts.force ? 0 : CACHE_TTL_MS,
  });
}
