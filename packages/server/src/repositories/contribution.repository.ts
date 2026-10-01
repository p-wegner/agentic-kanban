import { and, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import { issues, projectStatuses, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/** The workspace-level columns an actor can be grouped by in SQL (`author` is git-derived). */
export type WorkspaceGroupBy = "provider" | "profile" | "model";

export interface ContributionWindow {
  /** Inclusive lower bound (ISO). Omitted = unbounded. */
  from?: string;
  /** Inclusive upper bound (ISO). Omitted = unbounded. */
  to?: string;
}

export interface WorkspaceCountsRow {
  actor: string;
  workspaces: number;
  mergedIssues: number;
  doneIssues: number;
}

export interface SessionTotalsRow {
  actor: string;
  sessions: number;
  failedSessions: number;
  abortedSessions: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  activeMs: number | null;
}

export interface MergedWorkspaceRow {
  id: string;
  actor: string;
  branch: string;
  baseBranch: string | null;
  baseCommitSha: string | null;
  mergedHeadSha: string | null;
}

// ISO-8601 strings compare lexicographically, so an open bound is just a sentinel string.
const MIN_ISO = "";
const MAX_ISO = "￿";

function inWindow(column: SQL | { getSQL(): SQL }, window: ContributionWindow): SQL {
  return sql`(${column} >= ${window.from ?? MIN_ISO} and ${column} <= ${window.to ?? MAX_ISO})`;
}

/** The grouping key: the raw column, '' when unset (the service maps '' to a placeholder). */
function actorKey(groupBy: WorkspaceGroupBy): SQL<string> {
  const column =
    groupBy === "provider" ? workspaces.provider : groupBy === "profile" ? workspaces.claudeProfile : workspaces.model;
  return sql<string>`coalesce(${column}, '')`;
}

/** A numeric field of the `sessions.stats` JSON blob; NULL for absent/malformed blobs. */
function statsNumber(path: string): SQL<number | null> {
  return sql<number | null>`(case when json_valid(${sessions.stats}) then json_extract(${sessions.stats}, ${path}) end)`;
}

/**
 * Issue/workspace counts per actor, aggregated in SQL over the project's workspaces.
 * `workspaces` counts by creation time, `mergedIssues` by merge time, `doneIssues` by the
 * time the issue's status last changed (only issues currently in "Done").
 */
export async function getWorkspaceCountsByActor(
  projectId: string,
  groupBy: WorkspaceGroupBy,
  window: ContributionWindow,
  database: Database = db,
): Promise<WorkspaceCountsRow[]> {
  const key = actorKey(groupBy);
  const rows = await database
    .select({
      actor: key,
      workspaces: sql<number>`coalesce(sum(case when ${inWindow(workspaces.createdAt, window)} then 1 else 0 end), 0)`,
      mergedIssues: sql<number>`count(distinct case when ${isNotNull(workspaces.mergedAt)} and ${inWindow(workspaces.mergedAt, window)} then ${issues.id} end)`,
      doneIssues: sql<number>`count(distinct case when ${projectStatuses.name} = 'Done' and ${inWindow(sql`coalesce(${issues.statusChangedAt}, ${issues.updatedAt})`, window)} then ${issues.id} end)`,
    })
    .from(workspaces)
    .innerJoin(issues, eq(issues.id, workspaces.issueId))
    .innerJoin(projectStatuses, eq(projectStatuses.id, issues.statusId))
    .where(eq(issues.projectId, projectId))
    .groupBy(key);
  return rows.map((r) => ({
    actor: r.actor,
    workspaces: Number(r.workspaces),
    mergedIssues: Number(r.mergedIssues),
    doneIssues: Number(r.doneIssues),
  }));
}

/** Session counts, tokens, cost and duration per actor, summed in SQL from the stats blob. */
export async function getSessionTotalsByActor(
  projectId: string,
  groupBy: WorkspaceGroupBy,
  window: ContributionWindow,
  database: Database = db,
): Promise<SessionTotalsRow[]> {
  const key = actorKey(groupBy);
  const durationMs = sql<number | null>`coalesce(${statsNumber("$.durationMs")}, (julianday(${sessions.endedAt}) - julianday(${sessions.startedAt})) * 86400000.0)`;
  const rows = await database
    .select({
      actor: key,
      sessions: sql<number>`count(*)`,
      failedSessions: sql<number>`coalesce(sum(case when ${sessions.status} <> 'stopped' and (${sessions.status} = 'failed' or ${statsNumber("$.success")} = 0) then 1 else 0 end), 0)`,
      abortedSessions: sql<number>`coalesce(sum(case when ${sessions.status} = 'stopped' then 1 else 0 end), 0)`,
      inputTokens: sql<number | null>`sum(${statsNumber("$.inputTokens")})`,
      outputTokens: sql<number | null>`sum(${statsNumber("$.outputTokens")})`,
      costUsd: sql<number | null>`sum(${statsNumber("$.totalCostUsd")})`,
      activeMs: sql<number | null>`sum(${durationMs})`,
    })
    .from(sessions)
    .innerJoin(workspaces, eq(workspaces.id, sessions.workspaceId))
    .innerJoin(issues, eq(issues.id, workspaces.issueId))
    .where(and(eq(issues.projectId, projectId), inWindow(sessions.startedAt, window)))
    .groupBy(key);
  const num = (v: number | null) => (v === null || v === undefined ? null : Number(v));
  return rows.map((r) => ({
    actor: r.actor,
    sessions: Number(r.sessions),
    failedSessions: Number(r.failedSessions),
    abortedSessions: Number(r.abortedSessions),
    inputTokens: num(r.inputTokens),
    outputTokens: num(r.outputTokens),
    costUsd: num(r.costUsd),
    activeMs: num(r.activeMs),
  }));
}

/** The project's merged, non-direct workspaces inside the window — the git history to read. */
export async function getMergedWorkspaces(
  projectId: string,
  groupBy: WorkspaceGroupBy,
  window: ContributionWindow,
  database: Database = db,
): Promise<MergedWorkspaceRow[]> {
  return database
    .select({
      id: workspaces.id,
      actor: actorKey(groupBy),
      branch: workspaces.branch,
      baseBranch: workspaces.baseBranch,
      baseCommitSha: workspaces.baseCommitSha,
      mergedHeadSha: workspaces.mergedHeadSha,
    })
    .from(workspaces)
    .innerJoin(issues, eq(issues.id, workspaces.issueId))
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(workspaces.isDirect, false),
        isNotNull(workspaces.mergedAt),
        inWindow(workspaces.mergedAt, window),
      ),
    );
}
