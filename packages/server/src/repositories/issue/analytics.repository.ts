/**
 * The REPORTING read models over `issues` — Focus ranking, the cumulative-flow /
 * status-distribution timeline, throughput-and-lead-time, and the standup digest.
 *
 * These four belong together because they are the same KIND of query and nothing else
 * here is: each one selects a whole project's issues in a single unfiltered pass, joins
 * only what the presentation layer needs to bucket them (status name, workflow node
 * type, the create/move timestamps), and returns rows that no caller mutates. The
 * bucketing, the day axis and the scoring all stay in the services that call these —
 * so a change to how a chart is drawn never reaches this file, and a change here is
 * always about which columns a report needs.
 *
 * Their consumers are disjoint from the rest of the repository: focus.service,
 * issue-analytics(.service), digest.service. Nothing in the issue CRUD path calls them.
 */

import { issues, projectStatuses, workflowNodes } from "@agentic-kanban/shared/schema";
import { eq, and, gte } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { Database } from "../../db/index.js";
import { issueIdentityColumns } from "../projections.js";

/**
 * Issue rows projected for the Focus ranking ("what should I work on next?"):
 * status name + the current workflow node's type (so isTerminalStatusView can tell
 * done-ness), priority/estimate for scoring. One per-project read, no I/O beyond the DB.
 */
export async function getFocusIssueRows(projectId: string, database: Database = db) {
  return database
    .select({
      ...issueIdentityColumns,
      statusId: issues.statusId,
      statusName: projectStatuses.name,
      currentNodeId: issues.currentNodeId,
      currentNodeType: workflowNodes.nodeType,
      priority: issues.priority,
      issueType: issues.issueType,
      estimate: issues.estimate,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(eq(issues.projectId, projectId));
}

/**
 * All issues in a project with status name + sort order + the create/move
 * timestamps, for the cumulative-flow and status-distribution charts. Pure read;
 * the route builds the day axis and per-status counts.
 */
export async function getIssueStatusTimelineRows(projectId: string, database: Database = db) {
  return database
    .select({
      issueId: issues.id,
      createdAt: issues.createdAt,
      statusChangedAt: issues.statusChangedAt,
      statusName: projectStatuses.name,
      statusSortOrder: projectStatuses.sortOrder,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(issues.projectId, projectId));
}

/**
 * Issues currently in "Done" whose statusChangedAt falls on/after `cutoffDay`,
 * with their create/move timestamps — backs the throughput and lead-time charts.
 */
export async function getDoneIssuesSince(projectId: string, cutoffDay: string, database: Database = db) {
  return database
    .select({
      createdAt: issues.createdAt,
      statusChangedAt: issues.statusChangedAt,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(projectStatuses.name, "Done"),
        gte(issues.statusChangedAt, cutoffDay),
      ),
    );
}

/**
 * Issue rows for the standup digest: every issue in a project with its status
 * name, workflow node type, and the timestamps the digest windows on
 * (createdAt / statusChangedAt). Pure read; the route buckets these in JS.
 */
export async function getDigestIssueRows(projectId: string, database: Database = db) {
  return database
    .select({
      ...issueIdentityColumns,
      statusId: issues.statusId,
      statusName: projectStatuses.name,
      currentNodeId: issues.currentNodeId,
      currentNodeType: workflowNodes.nodeType,
      priority: issues.priority,
      issueType: issues.issueType,
      createdAt: issues.createdAt,
      statusChangedAt: issues.statusChangedAt,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(eq(issues.projectId, projectId));
}
