/**
 * #917 — scored ticket selection for the Todo-pull loop, split out of
 * `monitor-auto-start.ts` (the god-module gate's 1000-line ceiling) once this file plus
 * the read-only preview endpoint's backing function pushed it over.
 *
 * `orderCandidatesByStartScore` is what `runTodoPull` calls to replace FIFO
 * `ORDER BY issue_number`; `previewNextStartCandidates` is the read-only twin behind
 * `GET /api/projects/:id/board-monitor/next` — same score, no persistence, no launch.
 */
import { normalizeIssuePriority } from "@agentic-kanban/shared/lib/issue-priority";
import { readStrategyBullseye } from "@agentic-kanban/shared/lib/strategy-objective-file";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { Database } from "../db/index.js";
import { computeStartScore, hoursSince, matchBullseyeSegment, type StartScoreComponents, type StartScoreResult } from "../lib/start-scoring.js";
import {
  computeUnblockCounts,
  findProjectStatusIdByName,
  findStatusIdsByNames,
  persistStartScore,
  selectScorableCandidates,
} from "../repositories/start-scoring.repository.js";
import { resolveStartPolicy } from "../services/start-policy.service.js";
import { monitorEligibleIssueSql, notDriveOrEpicMetaSql, resolveCandidateStatusIds } from "./monitor-eligibility.js";

/** The subset of a Todo-pull candidate row the scorer needs. */
interface ScorableCandidate {
  id: string;
  title: string;
  description: string | null;
  issueType: string | null;
  priority: string;
  createdAt: string;
  statusChangedAt: string | null;
}

/**
 * #917: score every Todo-pull candidate — priorityWeight x (1 + unblockCount) x ageFactor
 * / predictedCost x bullseyeMultiplier — persist the score + its components on the issue
 * (`lastStartScore`/`lastStartScoreComponentsJson`/`lastStartScoredAt`, so
 * `GET /api/projects/:id/board-monitor/next` can show the same numbers the loop actually
 * used), and SORT `candidates` in place, highest score first.
 *
 * `predictedCost` intentionally does not call the AI estimator (`aiEstimateIssue`) here:
 * that is a per-issue LLM round trip, and this runs for every Todo/Backlog candidate on
 * every monitor cycle — an issue with no stored estimate scores with `predictedCost = 1`
 * (neutral), per the ticket's own "absent = 1" rule, rather than the loop paying an LLM
 * call just to decide iteration order.
 *
 * Age is measured from `statusChangedAt` (when the issue entered its current, startable
 * status) falling back to `createdAt` for a row that has never recorded a status change —
 * this is the STARVATION GUARD: a repeatedly re-tried blocked ticket accumulates age in
 * its current status and eventually outranks a fresher, nominally-higher-scoring one.
 */
export async function orderCandidatesByStartScore<T extends ScorableCandidate>(
  candidates: T[],
  projectId: string,
  doneStatusIds: ReadonlySet<string>,
  prefMap: Map<string, string>,
  database: Database,
): Promise<void> {
  if (candidates.length === 0) return;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const unblockCounts = await computeUnblockCounts(projectId, candidates.map((c) => c.id), doneStatusIds, database);
  const bullseye = readStrategyBullseye(prefMap, projectId);
  const segments = bullseye?.segments ?? [];

  const scored = candidates.map((issue) => {
    const { multiplier, segmentId } = matchBullseyeSegment(issue, segments);
    const result = computeStartScore({
      priority: normalizeIssuePriority(issue.priority),
      unblockCount: unblockCounts.get(issue.id) ?? 0,
      ageHours: hoursSince(issue.statusChangedAt ?? issue.createdAt, nowMs),
      bullseyeMultiplier: multiplier,
      bullseyeSegmentId: segmentId,
    });
    return { issue, result };
  });

  // Best-effort persistence: a write failure must never block the ordering it decorates.
  await Promise.all(scored.map(async ({ issue, result }) => {
    const components: StartScoreComponents = result;
    const err = await persistStartScore(
      issue.id,
      { score: result.score, componentsJson: JSON.stringify(components), scoredAt: nowIso },
      database,
    );
    if (err) console.warn(`[monitor] failed to persist start score for issue ${issue.id}: ${errorMessage(err)}`);
  }));

  const scoreById = new Map(scored.map(({ issue, result }) => [issue.id, result.score]));
  candidates.sort((a, b) => (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0));
}

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
