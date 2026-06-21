import type { Database } from "../db/index.js";
import { getIssueStatusTimelineRows, getDoneIssuesSince } from "../repositories/issue.repository.js";
import {
  computeBurndown,
  computeCfd,
  computeThroughput,
  computeLeadTime,
  cutoffDayFor,
  type BurndownResult,
  type CfdResult,
  type ThroughputResult,
  type LeadTimeResult,
} from "../lib/issue-analytics.js";

/**
 * Application layer for the board's time-series analytics charts. Each function
 * fetches the rows its chart needs via the repository, then hands them to the
 * pure aggregation core in `lib/issue-analytics.ts`. The HTTP routes (and any
 * future CLI/MCP adapter) stay thin: parse params -> call here -> return.
 *
 * `now` is injectable for deterministic tests; it defaults to the wall clock and
 * is snapshotted once so the DB cutoff and the rendered date axis agree.
 */

/** Burndown: remaining-open count + opened/closed deltas per day (full timeline). */
export async function getBurndownChart(
  projectId: string,
  days: number,
  database: Database,
  now: Date = new Date(),
): Promise<BurndownResult> {
  const rows = await getIssueStatusTimelineRows(projectId, database);
  return computeBurndown(rows, days, now);
}

/** Cumulative flow diagram: issues-per-status as of each day's end. */
export async function getCfdChart(
  projectId: string,
  days: number,
  database: Database,
  now: Date = new Date(),
): Promise<CfdResult> {
  const rows = await getIssueStatusTimelineRows(projectId, database);
  return computeCfd(rows, days, now);
}

/** Throughput: issues moved into Done per day across the trailing window. */
export async function getThroughputChart(
  projectId: string,
  days: number,
  database: Database,
  now: Date = new Date(),
): Promise<ThroughputResult> {
  const rows = await getDoneIssuesSince(projectId, cutoffDayFor(now, days), database);
  return computeThroughput(rows, days, now);
}

/** Lead-time: median + p90 age of issues reaching Done per day. */
export async function getLeadTimeChart(
  projectId: string,
  days: number,
  database: Database,
  now: Date = new Date(),
): Promise<LeadTimeResult> {
  const rows = await getDoneIssuesSince(projectId, cutoffDayFor(now, days), database);
  return computeLeadTime(rows, days, now);
}
