/**
 * #942 — the read-only twin of the Todo-pull loop's ranking, split out of
 * `startup/monitor-start-scoring.ts`.
 *
 * It backs `GET /api/projects/:id/board-monitor/next`, and a ROUTE may not reach into
 * `startup/` (the pattern language's `server-route -> server-monitor` rule, and the same
 * layering `.dependency-cruiser.cjs` enforces elsewhere). It never belonged there: unlike
 * `orderCandidatesByStartScore` next door it persists nothing, launches nothing, and is not
 * part of any cycle — it is a query behind an endpoint, i.e. a service.
 *
 * The DUPLICATION-vs-drift trade is deliberate: this recomputes the ranking rather than
 * reading `lastStartScore*` off the issues, because a status page must show what the loop
 * WOULD do now, not what it last did. The two stay honest by sharing the scoring primitive
 * (`computeStartScore`) and the eligibility fragments (via `selectStartCandidates`), which is
 * where the actual policy lives — only the persistence and the sort site differ.
 */
import { normalizeIssuePriority } from "@agentic-kanban/shared/lib/issue-priority";
import { readStrategyBullseye } from "@agentic-kanban/shared/lib/strategy-objective-file";
import type { Database } from "../db/index.js";
import { computeStartScore, hoursSince, matchBullseyeSegment, type StartScoreResult } from "../lib/start-scoring.js";
import {
  computeUnblockCounts,
  findProjectStatusIdByName,
  findStatusIdsByNames,
  monitorEligibleIssueSql,
  notDriveOrEpicMetaSql,
  resolveCandidateStatusIds,
  selectScorableCandidates,
} from "../repositories/start-scoring.repository.js";
import { resolveStartPolicy } from "./start-policy.service.js";

/** One ranked row of {@link previewNextStartCandidates}'s result. */
export interface StartScorePreviewRow {
  id: string;
  issueNumber: number | null;
  title: string;
  score: StartScoreResult;
}

/**
 * #917: read-only preview of the Todo-pull loop's current ranking for a project — backs
 * `GET /api/projects/:id/board-monitor/next`. Computes the same score
 * ({@link computeStartScore}) `orderCandidatesByStartScore` uses, but never writes
 * `lastStartScore*` back to the issue (a status-page read must not have side effects) and
 * never launches anything.
 */
export async function previewNextStartCandidates(
  projectId: string,
  prefMap: Map<string, string>,
  limit: number,
  database: Database,
): Promise<StartScorePreviewRow[]> {
  const allowFeatureTypes = resolveStartPolicy(prefMap, projectId).mode !== "manual";
  const todoStatusId = await findProjectStatusIdByName(projectId, "Todo", database);
  if (!todoStatusId) return [];

  const candidateStatusIds = await resolveCandidateStatusIds(projectId, todoStatusId, allowFeatureTypes, database);
  const candidates = await selectScorableCandidates(
    candidateStatusIds,
    [monitorEligibleIssueSql(allowFeatureTypes), notDriveOrEpicMetaSql()],
    database,
  );
  if (candidates.length === 0) return [];

  const doneStatusIds = await findStatusIdsByNames(["Done", "Cancelled"], database);

  const nowMs = Date.now();
  const unblockCounts = await computeUnblockCounts(projectId, candidates.map((c) => c.id), doneStatusIds, database);
  const bullseye = readStrategyBullseye(prefMap, projectId);
  const segments = bullseye?.segments ?? [];

  const ranked: StartScorePreviewRow[] = candidates.map((issue) => {
    const { multiplier, segmentId } = matchBullseyeSegment(issue, segments);
    const score = computeStartScore({
      priority: normalizeIssuePriority(issue.priority),
      unblockCount: unblockCounts.get(issue.id) ?? 0,
      ageHours: hoursSince(issue.statusChangedAt ?? issue.createdAt, nowMs),
      bullseyeMultiplier: multiplier,
      bullseyeSegmentId: segmentId,
    });
    return { id: issue.id, issueNumber: issue.issueNumber, title: issue.title, score };
  });
  ranked.sort((a, b) => b.score.score - a.score.score);
  return ranked.slice(0, limit);
}
