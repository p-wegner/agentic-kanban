/**
 * Per-project cache of computed pending-question responses.
 *
 * The listing is compute-on-read and was the slowest hot endpoint on large
 * projects (500-850ms measured), polled every 15-20s by up to three client
 * pollers. Entries pin the Database instance they were computed against so unit
 * tests (fresh in-memory DB per test, reused project ids) never see another
 * test's cache. Invalidation paths:
 *  - any board event for the project (server-start wires
 *    boardEvents.addInvalidationListener -> invalidateAgentQuestionsCache);
 *    session exits, workspace status changes, and MCP comment inserts
 *    (notifyBoard) all flow through that broadcast
 *  - markAnswered / markDismissed (no projectId in scope -> clear all)
 *  - setCachedRecommendations (a recommendation landing changes the attached
 *    `recommendation` field -> clear all)
 * The TTL is a safety net only — correctness comes from the invalidation paths.
 */
import type { Database } from "../../db/index.js";
import type { PendingQuestionSet } from "./types.js";

export const AGENT_QUESTIONS_CACHE_TTL_MS = 30_000;

export const pendingQuestionsCache = new Map<
  string,
  { db: Database; result: PendingQuestionSet[]; computedAt: number }
>();

/** Drop the cached pending-questions response for one project (or all when omitted). */
export function invalidateAgentQuestionsCache(projectId?: string): void {
  if (projectId === undefined) pendingQuestionsCache.clear();
  else pendingQuestionsCache.delete(projectId);
}
