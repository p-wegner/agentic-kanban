/**
 * #917 — scored ticket selection for the Todo-pull loop, split out of
 * `monitor-auto-start.ts` (the god-module gate's 1000-line ceiling).
 *
 * `orderCandidatesByStartScore` is what `runTodoPull` calls to replace FIFO
 * `ORDER BY issue_number`. Its read-only twin behind
 * `GET /api/projects/:id/board-monitor/next` used to live here too; #942 moved it to
 * `services/start-score-preview.service.ts`, because a route reaching into `startup/` is
 * the `server-route -> server-monitor` violation the pattern language forbids — and the
 * preview persists nothing and launches nothing, so it was never monitor-engine code.
 */
import { normalizeIssuePriority } from "@agentic-kanban/shared/lib/issue-priority";
import { readStrategyBullseye } from "@agentic-kanban/shared/lib/strategy-objective-file";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { Database } from "../db/index.js";
import { computeStartScore, hoursSince, matchBullseyeSegment, type StartScoreComponents } from "../lib/start-scoring.js";
import {
  computeUnblockCounts,
  persistStartScore,
} from "../repositories/start-scoring.repository.js";

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
