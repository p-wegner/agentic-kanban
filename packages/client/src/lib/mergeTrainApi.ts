import type { MergeTrainsResponse, MergeTrainWindowResponse } from "@agentic-kanban/shared";
import { apiFetch } from "./api.js";

/**
 * The merge-train read endpoints, as plain fetchers (#1195, #1186, #1198).
 *
 * Kept OUT of the components on purpose: `fetch-in-effect-ratchet.test.ts` (#603) is a
 * down-only ring over modules that call `apiFetch` next to a React effect, and both the
 * flight recorder and the merge-queue panel had grown a new hand-rolled ladder each. A
 * fetcher module with no effect in it is the same shape `agentQuestionsStore.ts` and
 * `workspacesListQuery.ts` already use for the other feeds those components consume.
 */
export function fetchMergeTrains(projectId: string): Promise<MergeTrainsResponse> {
  return apiFetch<MergeTrainsResponse>(`/api/merge-queue/trains?projectId=${encodeURIComponent(projectId)}`);
}

export function fetchMergeTrainWindow(projectId: string): Promise<MergeTrainWindowResponse> {
  return apiFetch<MergeTrainWindowResponse>(`/api/merge-queue/window?projectId=${encodeURIComponent(projectId)}`);
}
