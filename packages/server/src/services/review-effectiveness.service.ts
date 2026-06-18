import { parseSessionSummary } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import { getSessionMessageRows } from "../repositories/session.repository.js";
import {
  getAllDependencyEdges,
  getDiffCommentRowsForWorkspaces,
  getProjectIssueIds,
  getReviewEffectivenessSessionRows,
} from "../repositories/review-effectiveness.repository.js";

/**
 * Reconstructs each ticket's build -> review -> merge lifecycle from sessions +
 * workspaces + diff comments over a window, and reports how the implementation
 * workflow interacts with AI code review: coverage, bounce-backs, scorecard
 * distribution, cost split.
 *
 * Extracted from `pnpm cli -- session review-effectiveness` so the same analysis
 * can be scoped to a single Drive (#805): instead of a `--days` window over the
 * whole active project, the drive scopes it to the drive's time window and — when
 * the drive has a meta-issue — to the meta-issue's dependency subtree.
 */

export interface ReviewEffectivenessScope {
  projectId: string;
  /** Lower bound (inclusive) for `sessions.startedAt`, ISO string. */
  sinceIso: string;
  /** Optional upper bound (inclusive) for `sessions.startedAt`, ISO string. */
  untilIso?: string | null;
  /**
   * Optional restriction to a specific set of issue ids (e.g. a drive's
   * meta-issue + its dependency subtree). When omitted, all of the project's
   * issues in the window are considered.
   */
  issueIds?: string[] | null;
  /**
   * Also load each review session's transcript and classify its self-reported
   * verdict (approve vs changes-requested). Slower.
   */
  deep?: boolean;
}

export type ReviewKind = "review" | "build" | "rework" | "noise" | "other";

export function classifyTrigger(t: string | null): ReviewKind {
  if (!t) return "build"; // legacy initial sessions have null triggerType
  if (t === "review" || t.startsWith("skill:code-review")) return "review";
  if (t.startsWith("skill:board-monitor") || t.startsWith("skill:board-navigator")) return "noise";
  if (t === "chat" || t === "fix-and-merge" || t === "fix-conflicts" || t === "plan-reject") return "rework";
  if (t === "verify" || t === "learning" || t === "bisect" || t === "reconcile") return "other";
  return "build"; // agent, auto-start, manual, plan-implement, skill:<other>
}

function parseStats(raw: string | null) {
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

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it) || "(unknown)";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

export interface ReviewEffectivenessReport {
  window: { since: string; until: string | null; projectId: string; scopedIssueCount: number | null };
  totals: {
    sessionsInWindow: number;
    ticketAttemptsTouched: number;
    implementationAttempts: number;
    mergedInWindow: number;
    buildRuns: number;
    reviewRuns: number;
    reworkRuns: number;
  };
  reviewCoverage: {
    attemptsReviewed: number;
    pctOfImplReviewed: number;
    mergedReviewedBeforeLanding: number;
    pctOfMergedReviewed: number;
    mergedWithoutReview: Array<{ issue: number | null; title: string; status: string }>;
  };
  reviewImpact: {
    reviewsThatBouncedBackToWork: number;
    pctReviewsLeadingToChange: number;
    avgReviewRoundsPerReviewedTicket: number | null;
    avgBuildRunsPerImplTicket: number | null;
    diffCommentsRaised: number;
    diffCommentsResolved: number;
    pctCommentsResolved: number;
    ticketsWithReviewComments: number;
  };
  scorecard: {
    note: string;
    count: number;
    avg: number | null;
    median: number | null;
    min: number | null;
    max: number | null;
    buckets: Record<string, number>;
    lowScoreMergedAnyway: Array<{ issue: number | null; score: number | null }>;
  };
  cost: { reviewCostUsd: number; buildCostUsd: number; reviewPctOfTotalCost: number };
  providerSplit: { reviewsByExecutor: Record<string, number>; buildsByExecutor: Record<string, number> };
  verdicts?: { approve: number; changesRequested: number; unclear: number };
  triggerTypeDistribution: Record<string, number>;
  perTicket: Array<{
    issue: number | null;
    title: string;
    provider: string | null;
    builds: number;
    reviews: number;
    reworks: number;
    changeAfterReview: boolean;
    comments: number;
    scorecard: number | null;
    merged: boolean;
    wsStatus: string;
  }>;
}

/**
 * Run the build->review->merge lifecycle analysis for a scope.
 * Pure data; the caller decides how to render it (CLI report or JSON).
 */
export async function computeReviewEffectiveness(
  scope: ReviewEffectivenessScope,
  database: Database,
): Promise<ReviewEffectivenessReport> {
  const { projectId, sinceIso, untilIso, issueIds, deep } = scope;

  const rows = await getReviewEffectivenessSessionRows(
    { projectId, sinceIso, untilIso, issueIds },
    database,
  );

  const wsIds = [...new Set(rows.map((r) => r.workspaceId))];
  const commentRows = await getDiffCommentRowsForWorkspaces(wsIds, database);

  type WS = {
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
  };
  const byWs = new Map<string, WS>();
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
    const ws: WS = existing;
    const st = parseStats(r.stats);
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

  const all = [...byWs.values()];
  const impl = all.filter((w) => w.builds > 0 || w.reworks > 0);
  const reviewed = all.filter((w) => w.reviews > 0);
  const mergedInWindow = all.filter((w) => w.mergedAt && w.mergedAt >= sinceIso && (!untilIso || w.mergedAt <= untilIso));
  const mergedReviewed = mergedInWindow.filter((w) => w.reviews > 0);
  const mergedUnreviewed = mergedInWindow.filter((w) => w.reviews === 0);
  const reviewsLeadingToChange = reviewed.filter((w) => w.changeAfterReview);
  const reviewedWithComments = reviewed.filter((w) => w.comments > 0);

  const totalReviewRuns = all.reduce((s, w) => s + w.reviews, 0);
  const totalBuildRuns = all.reduce((s, w) => s + w.builds, 0);
  const totalReworkRuns = all.reduce((s, w) => s + w.reworks, 0);
  const totalComments = all.reduce((s, w) => s + w.comments, 0);
  const totalCommentsResolved = all.reduce((s, w) => s + w.commentsResolved, 0);
  const reviewCost = all.reduce((s, w) => s + w.reviewCost, 0);
  const buildCost = all.reduce((s, w) => s + w.buildCost, 0);

  const scores = reviewed.map((w) => w.scorecardScore).filter((s): s is number => typeof s === "number");
  const scoreBuckets = { "90-100": 0, "75-89": 0, "60-74": 0, "<60": 0 };
  for (const s of scores) {
    if (s >= 90) scoreBuckets["90-100"]++;
    else if (s >= 75) scoreBuckets["75-89"]++;
    else if (s >= 60) scoreBuckets["60-74"]++;
    else scoreBuckets["<60"]++;
  }

  let verdicts: { approve: number; changesRequested: number; unclear: number } | undefined;
  if (deep) {
    verdicts = { approve: 0, changesRequested: 0, unclear: 0 };
    const reviewSessionIds = all.flatMap((w) => w.reviewSessionIds);
    for (const sid of reviewSessionIds) {
      const msgRows = await getSessionMessageRows(sid);
      const summary = parseSessionSummary(msgRows);
      const text = (summary.agentSummary ?? "").toLowerCase();
      const approve = /ready for merge|marking .*ready|approved|no critical or major|lgtm/.test(text);
      const changes = /request changes|moving .*back to in progress|moved .*to in progress|needs fixes|requires changes|back to the agent|critical issue|major issue/.test(text);
      if (changes && !approve) verdicts.changesRequested++;
      else if (approve && !changes) verdicts.approve++;
      else if (approve && changes) verdicts.approve++;
      else verdicts.unclear++;
    }
  }

  return {
    window: { since: sinceIso, until: untilIso ?? null, projectId, scopedIssueCount: issueIds ? issueIds.length : null },
    totals: {
      sessionsInWindow: rows.length,
      ticketAttemptsTouched: all.length,
      implementationAttempts: impl.length,
      mergedInWindow: mergedInWindow.length,
      buildRuns: totalBuildRuns,
      reviewRuns: totalReviewRuns,
      reworkRuns: totalReworkRuns,
    },
    reviewCoverage: {
      attemptsReviewed: reviewed.length,
      pctOfImplReviewed: pct(impl.filter((w) => w.reviews > 0).length, impl.length),
      mergedReviewedBeforeLanding: mergedReviewed.length,
      pctOfMergedReviewed: pct(mergedReviewed.length, mergedInWindow.length),
      mergedWithoutReview: mergedUnreviewed.map((w) => ({ issue: w.issueNumber, title: w.issueTitle, status: w.wsStatus })),
    },
    reviewImpact: {
      reviewsThatBouncedBackToWork: reviewsLeadingToChange.length,
      pctReviewsLeadingToChange: pct(reviewsLeadingToChange.length, reviewed.length),
      avgReviewRoundsPerReviewedTicket: avg(reviewed.map((w) => w.reviews)),
      avgBuildRunsPerImplTicket: avg(impl.map((w) => w.builds + w.reworks)),
      diffCommentsRaised: totalComments,
      diffCommentsResolved: totalCommentsResolved,
      pctCommentsResolved: pct(totalCommentsResolved, totalComments),
      ticketsWithReviewComments: reviewedWithComments.length,
    },
    scorecard: {
      note: "Heuristic health score (tests/types/scope/diff-size/conflicts/docs), NOT the LLM reviewer's verdict.",
      count: scores.length,
      avg: avg(scores),
      median: median(scores),
      min: scores.length ? Math.min(...scores) : null,
      max: scores.length ? Math.max(...scores) : null,
      buckets: scoreBuckets,
      lowScoreMergedAnyway: mergedReviewed
        .filter((w) => typeof w.scorecardScore === "number" && w.scorecardScore < 60)
        .map((w) => ({ issue: w.issueNumber, score: w.scorecardScore })),
    },
    cost: {
      reviewCostUsd: Math.round(reviewCost * 100) / 100,
      buildCostUsd: Math.round(buildCost * 100) / 100,
      reviewPctOfTotalCost: pct(reviewCost, reviewCost + buildCost),
    },
    providerSplit: {
      reviewsByExecutor: countBy(rows.filter((r) => classifyTrigger(r.triggerType) === "review"), (r) => r.executor),
      buildsByExecutor: countBy(rows.filter((r) => classifyTrigger(r.triggerType) === "build"), (r) => r.executor),
    },
    verdicts,
    triggerTypeDistribution: triggerDist,
    perTicket: impl
      .sort((a, b) => (a.issueNumber ?? 0) - (b.issueNumber ?? 0))
      .map((w) => ({
        issue: w.issueNumber,
        title: w.issueTitle.slice(0, 50),
        provider: w.provider,
        builds: w.builds,
        reviews: w.reviews,
        reworks: w.reworks,
        changeAfterReview: w.changeAfterReview,
        comments: w.comments,
        scorecard: w.scorecardScore,
        merged: !!w.mergedAt,
        wsStatus: w.wsStatus,
      })),
  };
}

/**
 * Resolve the set of issue ids that belong to a drive: the meta-issue plus its
 * dependency subtree (children reachable via `parent_of`/`depends_on` etc.).
 * Returns null when the drive has no meta-issue (caller should fall back to the
 * whole-project-in-window scope). Returns a non-empty array including the meta
 * issue itself otherwise.
 */
export async function resolveDriveIssueIds(
  metaIssueId: string | null,
  projectId: string,
  database: Database,
): Promise<string[] | null> {
  if (!metaIssueId) return null;

  // BFS over issue_dependencies in both directions so we capture the epic's
  // children regardless of which side of the edge they were recorded on
  // (the decomposer links children via parent_of/child_of; some flows use
  // depends_on). We only keep edges within this project.
  const projectIssueRows = await getProjectIssueIds(projectId, database);
  const inProject = new Set(projectIssueRows.map((r) => r.id));

  const edges = await getAllDependencyEdges(database);
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a)!.add(b);
  };
  for (const e of edges) {
    if (!inProject.has(e.issueId) || !inProject.has(e.dependsOnId)) continue;
    link(e.issueId, e.dependsOnId);
    link(e.dependsOnId, e.issueId);
  }

  const visited = new Set<string>([metaIssueId]);
  const queue = [metaIssueId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of adjacency.get(cur) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return [...visited];
}

/** Render a report as the human-readable CLI text block. */
export function renderReviewEffectivenessReport(
  report: ReviewEffectivenessReport,
  header: string,
): string {
  const sc = report.scorecard;
  const L: string[] = [];
  L.push(`\n${header}`);
  L.push(
    `Sessions in window: ${report.totals.sessionsInWindow}  |  ticket attempts: ${report.totals.ticketAttemptsTouched}  |  with build work: ${report.totals.implementationAttempts}  |  merged in window: ${report.totals.mergedInWindow}`,
  );
  L.push(`Run mix: ${report.totals.buildRuns} build · ${report.totals.reviewRuns} review · ${report.totals.reworkRuns} rework`);
  L.push(`\n-- Review coverage --`);
  L.push(`  Implementation attempts reviewed:     ${report.reviewCoverage.attemptsReviewed} reviewed  (${report.reviewCoverage.pctOfImplReviewed}% of impl)`);
  L.push(`  Merged tickets reviewed before landing: ${report.reviewCoverage.mergedReviewedBeforeLanding}/${report.totals.mergedInWindow}  (${report.reviewCoverage.pctOfMergedReviewed}%)`);
  if (report.reviewCoverage.mergedWithoutReview.length) {
    L.push(`  ⚠ Merged WITHOUT a review run in window: ${report.reviewCoverage.mergedWithoutReview.map((w) => "#" + w.issue).join(", ")}`);
  }
  L.push(`\n-- Did reviews do real work? --`);
  L.push(`  Reviews that bounced a ticket back to building: ${report.reviewImpact.reviewsThatBouncedBackToWork}/${report.reviewCoverage.attemptsReviewed}  (${report.reviewImpact.pctReviewsLeadingToChange}%)`);
  L.push(`  Avg review rounds / reviewed ticket:  ${report.reviewImpact.avgReviewRoundsPerReviewedTicket ?? "-"}`);
  L.push(`  Avg build runs / impl ticket:         ${report.reviewImpact.avgBuildRunsPerImplTicket ?? "-"}`);
  L.push(`  Inline review findings (diff comments): ${report.reviewImpact.diffCommentsRaised} raised, ${report.reviewImpact.diffCommentsResolved} resolved (${report.reviewImpact.pctCommentsResolved}%) across ${report.reviewImpact.ticketsWithReviewComments} tickets`);
  L.push(`\n-- Scorecard (heuristic health, not the reviewer's verdict) --`);
  L.push(`  n=${sc.count}  avg=${sc.avg ?? "-"}  median=${sc.median ?? "-"}  range=${sc.min ?? "-"}..${sc.max ?? "-"}`);
  L.push(`  Buckets: 90-100=${sc.buckets["90-100"]}  75-89=${sc.buckets["75-89"]}  60-74=${sc.buckets["60-74"]}  <60=${sc.buckets["<60"]}`);
  if (sc.lowScoreMergedAnyway.length) {
    L.push(`  ⚠ Low-score (<60) merged anyway: ${sc.lowScoreMergedAnyway.map((x) => `#${x.issue}(${x.score})`).join(", ")}`);
  }
  L.push(`\n-- Cost --`);
  L.push(`  Review: $${report.cost.reviewCostUsd}  ·  Build: $${report.cost.buildCostUsd}  ·  review = ${report.cost.reviewPctOfTotalCost}% of agent spend`);
  L.push(`\n-- Provider split --`);
  L.push(`  Reviews by executor:  ${JSON.stringify(report.providerSplit.reviewsByExecutor)}`);
  L.push(`  Builds  by executor:  ${JSON.stringify(report.providerSplit.buildsByExecutor)}`);
  if (report.verdicts) {
    L.push(`\n-- Review self-reported verdicts (deep, heuristic text parse) --`);
    L.push(`  approve=${report.verdicts.approve}  changes-requested=${report.verdicts.changesRequested}  unclear=${report.verdicts.unclear}`);
  }
  L.push(`\n-- Per-ticket lifecycle --`);
  L.push(`  ${"issue".padEnd(7)}${"prov".padEnd(8)}${"bld".padEnd(4)}${"rev".padEnd(4)}${"rwk".padEnd(4)}${"chg".padEnd(4)}${"cmt".padEnd(4)}${"score".padEnd(6)}${"merged".padEnd(7)}title`);
  for (const t of report.perTicket) {
    L.push(
      `  ${("#" + t.issue).padEnd(7)}${String(t.provider ?? "?").padEnd(8)}${String(t.builds).padEnd(4)}${String(t.reviews).padEnd(4)}${String(t.reworks).padEnd(4)}${(t.changeAfterReview ? "Y" : "·").padEnd(4)}${String(t.comments).padEnd(4)}${String(t.scorecard ?? "-").padEnd(6)}${(t.merged ? "yes" : t.wsStatus).padEnd(7)}${t.title}`,
    );
  }
  L.push(`\nTrigger types seen: ${JSON.stringify(report.triggerTypeDistribution)}`);
  L.push("");
  return L.join("\n");
}
