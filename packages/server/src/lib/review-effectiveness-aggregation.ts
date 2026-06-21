/**
 * Pure aggregation/classification core for the review-effectiveness analysis
 * (issue #860). `computeReviewEffectiveness` (review-effectiveness.service.ts)
 * tangled three pure, currently-untestable chunks with its DB I/O: the per-row
 * build→review→rework aggregation loop, the scorecard bucketing, and the
 * deep-mode regex verdict classifier. Those are extracted here as pure functions
 * (no I/O) so they are table-testable in ms; the service keeps the DB reads and
 * report assembly and just calls these for the data transforms.
 *
 * This is a leaf module — it imports nothing from services/repositories. Distinct
 * from `lib/review-effectiveness-report.ts` (which backs the git-attribution CLI
 * feature); do not conflate.
 */

export type ReviewKind = "review" | "build" | "rework" | "noise" | "other";

/**
 * Classify a session's `triggerType` into a lifecycle role. Legacy initial
 * sessions have a null triggerType and are treated as build runs.
 */
export function classifyTrigger(t: string | null): ReviewKind {
  if (!t) return "build"; // legacy initial sessions have null triggerType
  if (t === "review" || t.startsWith("skill:code-review")) return "review";
  if (t.startsWith("skill:board-monitor") || t.startsWith("skill:board-navigator")) return "noise";
  if (t === "chat" || t === "fix-and-merge" || t === "fix-conflicts" || t === "plan-reject") return "rework";
  if (t === "verify" || t === "learning" || t === "bisect" || t === "reconcile") return "other";
  return "build"; // agent, auto-start, manual, plan-implement, skill:<other>
}

/** Parse a session's persisted `stats` JSON into the cost/duration/turns we aggregate. */
export function parseSessionStats(raw: string | null): { cost: number; durationMs: number; turns: number } {
  if (!raw) return { cost: 0, durationMs: 0, turns: 0 };
  try {
    const s = JSON.parse(raw) as Record<string, unknown>;
    return {
      cost: typeof s.totalCostUsd === "number" ? s.totalCostUsd : 0,
      durationMs: typeof s.durationMs === "number" ? s.durationMs : 0,
      turns: typeof s.numTurns === "number" ? s.numTurns : 0,
    };
  } catch {
    return { cost: 0, durationMs: 0, turns: 0 };
  }
}

/**
 * Minimal structural view of a review-effectiveness session row the aggregation
 * needs. The repository's `ReviewEffectivenessSessionRow` is assignable to this
 * (it carries the same fields plus extras), so the service passes its rows through
 * without a copy, while this module stays a leaf (no repository import).
 */
export interface ReviewEffSessionInput {
  sessionId: string;
  triggerType: string | null;
  startedAt: string;
  stats: string | null;
  workspaceId: string;
  branch: string;
  wsStatus: string;
  provider: string | null;
  mergedAt: string | null;
  readyForMerge: boolean;
  requiresReview: boolean;
  scorecardScore: number | null;
  issueNumber: number | null;
  issueTitle: string;
  issueType: string;
}

/** A diff-comment row reduced to what the aggregation needs. */
export interface ReviewEffCommentInput {
  workspaceId: string;
  resolvedAt: string | null;
}

/** Per-workspace (ticket-attempt) lifecycle stats accumulated from its sessions + comments. */
export interface ReviewWorkspaceStats {
  workspaceId: string;
  issueNumber: number | null;
  issueTitle: string;
  issueType: string;
  branch: string;
  provider: string | null;
  wsStatus: string;
  mergedAt: string | null;
  readyForMerge: boolean;
  requiresReview: boolean;
  scorecardScore: number | null;
  builds: number;
  reviews: number;
  reworks: number;
  firstReviewAt: string | null;
  lastReviewAt: string | null;
  changeAfterReview: boolean;
  reviewCost: number;
  buildCost: number;
  reviewDurationMs: number;
  comments: number;
  commentsResolved: number;
  reviewSessionIds: string[];
}

/**
 * Fold session rows plus their diff comments into a per-workspace lifecycle map,
 * and tally the raw triggerType distribution. Noise sessions (board-monitor/navigator
 * skills) count toward the distribution but do not create or mutate a workspace entry.
 * A build/rework session that started strictly after the first review marks the attempt
 * as `changeAfterReview` (a bounce-back).
 *
 * PRECONDITION: `rows` must be in ascending `startedAt` order (the repository's
 * `getReviewEffectivenessSessionRows` guarantees this via `.orderBy(sessions.startedAt)`).
 * `firstReviewAt`/`lastReviewAt` and the `changeAfterReview` bounce-back detection depend
 * on it — out-of-order rows would mis-detect bounce-backs. This function does not sort.
 */
export function aggregateReviewWorkspaceStats(
  rows: ReviewEffSessionInput[],
  commentRows: ReviewEffCommentInput[],
): { byWs: Map<string, ReviewWorkspaceStats>; triggerDist: Record<string, number> } {
  const byWs = new Map<string, ReviewWorkspaceStats>();
  const commentsByWs = new Map<string, { total: number; resolved: number }>();
  for (const c of commentRows) {
    const e = commentsByWs.get(c.workspaceId) ?? { total: 0, resolved: 0 };
    e.total++;
    if (c.resolvedAt) e.resolved++;
    commentsByWs.set(c.workspaceId, e);
  }

  const triggerDist: Record<string, number> = {};

  for (const r of rows) {
    triggerDist[r.triggerType ?? "(null)"] = (triggerDist[r.triggerType ?? "(null)"] ?? 0) + 1;
    const kind = classifyTrigger(r.triggerType);
    if (kind === "noise") continue;

    let existing = byWs.get(r.workspaceId);
    if (!existing) {
      const cm = commentsByWs.get(r.workspaceId) ?? { total: 0, resolved: 0 };
      existing = {
        workspaceId: r.workspaceId,
        issueNumber: r.issueNumber,
        issueTitle: r.issueTitle,
        issueType: r.issueType,
        branch: r.branch,
        provider: r.provider,
        wsStatus: r.wsStatus,
        mergedAt: r.mergedAt,
        readyForMerge: r.readyForMerge,
        requiresReview: r.requiresReview,
        scorecardScore: r.scorecardScore,
        builds: 0,
        reviews: 0,
        reworks: 0,
        firstReviewAt: null,
        lastReviewAt: null,
        changeAfterReview: false,
        reviewCost: 0,
        buildCost: 0,
        reviewDurationMs: 0,
        comments: cm.total,
        commentsResolved: cm.resolved,
        reviewSessionIds: [],
      };
      byWs.set(r.workspaceId, existing);
    }
    const ws: ReviewWorkspaceStats = existing;
    const st = parseSessionStats(r.stats);
    if (kind === "review") {
      ws.reviews++;
      ws.reviewCost += st.cost;
      ws.reviewDurationMs += st.durationMs;
      ws.reviewSessionIds.push(r.sessionId);
      if (!ws.firstReviewAt) ws.firstReviewAt = r.startedAt;
      ws.lastReviewAt = r.startedAt;
    } else if (kind === "build") {
      ws.builds++;
      ws.buildCost += st.cost;
      if (ws.firstReviewAt && r.startedAt > ws.firstReviewAt) ws.changeAfterReview = true;
    } else if (kind === "rework") {
      ws.reworks++;
      ws.buildCost += st.cost;
      if (ws.firstReviewAt && r.startedAt > ws.firstReviewAt) ws.changeAfterReview = true;
    }
  }

  return { byWs, triggerDist };
}

/** Scorecard score histogram bucket labels (descending bands). */
export type ScorecardBucket = "90-100" | "75-89" | "60-74" | "<60";

/** Bucket heuristic scorecard scores into the report's four descending bands. */
export function bucketScorecardScores(scores: number[]): Record<ScorecardBucket, number> {
  const scoreBuckets: Record<ScorecardBucket, number> = { "90-100": 0, "75-89": 0, "60-74": 0, "<60": 0 };
  for (const s of scores) {
    if (s >= 90) scoreBuckets["90-100"]++;
    else if (s >= 75) scoreBuckets["75-89"]++;
    else if (s >= 60) scoreBuckets["60-74"]++;
    else scoreBuckets["<60"]++;
  }
  return scoreBuckets;
}

/**
 * Classify a review session's self-reported verdict from its summary text.
 * Approve and changes-requested signals are matched independently; when both (or
 * neither) fire the original tie-breaks resolve to approve / unclear respectively.
 * The text is lower-cased here, so callers pass the raw agent summary.
 */
export function classifyReviewVerdictText(text: string): "approve" | "changesRequested" | "unclear" {
  const t = text.toLowerCase();
  const approve = /ready for merge|marking .*ready|approved|no critical or major|lgtm/.test(t);
  const changes = /request changes|moving .*back to in progress|moved .*to in progress|needs fixes|requires changes|back to the agent|critical issue|major issue/.test(t);
  if (changes && !approve) return "changesRequested";
  if (approve && !changes) return "approve";
  if (approve && changes) return "approve";
  return "unclear";
}
