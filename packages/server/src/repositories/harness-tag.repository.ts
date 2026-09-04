import { issues, issueTags, projectStatuses, tags, workspaces } from "@agentic-kanban/shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { HARNESS_TAG, harnessSharePct } from "@agentic-kanban/shared/lib/harness-budget";
import { activeWipPredicate } from "./wip-capacity.repository.js";
import { db } from "../db/index.js";

/**
 * Reads for the harness budget (#1021). A REPOSITORY because every one of these builds a
 * drizzle query — a service that did so trips depcruise's `services-bypass-repositories`,
 * and `startup/` sits outside the layering rules entirely (#595).
 */

type Selector = Pick<typeof db, "select">;

/**
 * Which of these issues carry the `harness` tag. A SET rather than a per-issue predicate:
 * the auto-start pull loop already holds its whole candidate list, and asking once beats one
 * round trip per candidate on a backlog that can be dozens long.
 */
export async function selectHarnessIssueIds(database: Selector, issueIds: string[]): Promise<Set<string>> {
  if (issueIds.length === 0) return new Set();
  const rows = await database.select({ issueId: issueTags.issueId })
    .from(issueTags)
    .innerJoin(tags, eq(issueTags.tagId, tags.id))
    .where(and(inArray(issueTags.issueId, issueIds), eq(tags.name, HARNESS_TAG)));
  return new Set(rows.map((r) => r.issueId));
}

/**
 * How many of the project's ACTIVE builders are working a `harness` ticket right now.
 *
 * Counted over the same population `countWipCapacity` counts — In-Progress issues with an
 * `active`/`reviewing`/`fixing` workspace — so the budget and the WIP limit it is a share OF
 * can never be measured against different denominators. A group workspace is keyed by its
 * lead issue, so a group counts as one builder, which is what it is.
 */
export async function countActiveHarnessWip(database: Selector, inProgressStatusId: string): Promise<number> {
  const rows = await database.select({
    active: sql<number>`count(distinct CASE WHEN ${activeWipPredicate} THEN ${issues.id} END)`,
  }).from(issues)
    .innerJoin(workspaces, eq(workspaces.issueId, issues.id))
    .innerJoin(issueTags, eq(issueTags.issueId, issues.id))
    .innerJoin(tags, eq(issueTags.tagId, tags.id))
    .where(and(eq(issues.statusId, inProgressStatusId), eq(tags.name, HARNESS_TAG)));
  return Number(rows[0]?.active ?? 0);
}

export interface HarnessShareSnapshot {
  /** Tickets that reached Done in the window. */
  doneCount: number;
  /** Of those, how many carried the `harness` tag. */
  harnessCount: number;
  /** `harnessCount / doneCount` as a percentage, or null when nothing landed in the window. */
  sharePct: number | null;
  /** How wide the window is, so a reader is never guessing what "this week" meant. */
  windowDays: number;
}

const WINDOW_DAYS = 7;

/**
 * The read-off the proposal's 61 % figure came from, computed instead of grepped (#1021).
 *
 * Measured over tickets that reached **Done** in the last 7 days (`statusChangedAt`), across
 * every project — the same population an operator means by "what did the board ship this
 * week". `nowMs` is injectable so a test can seed relative timestamps without waiting for the
 * clock (the project's time-injection convention, root CLAUDE.md).
 */
export async function readHarnessShare(
  database: Selector = db,
  nowMs: number = Date.now(),
): Promise<HarnessShareSnapshot> {
  const since = new Date(nowMs - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const doneStatuses = await database.select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(eq(projectStatuses.name, "Done"));
  const doneStatusIds = doneStatuses.map((s) => s.id);
  if (doneStatusIds.length === 0) {
    return { doneCount: 0, harnessCount: 0, sharePct: null, windowDays: WINDOW_DAYS };
  }

  const rows = await database.select({ id: issues.id })
    .from(issues)
    .where(and(inArray(issues.statusId, doneStatusIds), sql`${issues.statusChangedAt} >= ${since}`));
  const doneIds = rows.map((r) => r.id);
  const harnessIds = await selectHarnessIssueIds(database, doneIds);
  return {
    doneCount: doneIds.length,
    harnessCount: harnessIds.size,
    sharePct: harnessSharePct(doneIds.length, harnessIds.size),
    windowDays: WINDOW_DAYS,
  };
}
