import { randomUUID } from "node:crypto";
import { issues, issueTags, tags, projectStatuses } from "@agentic-kanban/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { transitionIssueStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { projectStatusIdName } from "./projections.js";
import { listProjectStatusIdNames } from "./project-status.repository.js";

/**
 * Find or create the `voice-capture` tag for the given database.
 * Returns the tag id.
 */
export async function ensureVoiceCaptureTag(database: Database = db): Promise<string> {
  const TAG_NAME = "voice-capture";
  const existing = await database
    .select({ id: tags.id })
    .from(tags)
    .where(sql`lower(${tags.name}) = lower(${TAG_NAME})`)
    .limit(1);
  if (existing[0]) return existing[0].id;
  const id = randomUUID();
  await database.insert(tags).values({
    id,
    name: TAG_NAME,
    color: "#8b5cf6",
    createdAt: new Date().toISOString(),
  });
  return id;
}

/**
 * ORDER-DEPENDENT (#773). This is the same defect class as the seven
 * `listProjectStatusIdNames` sites, in a query that keeps its own shape because it also
 * needs `isDefault`: `resolveBacklogStatusId` falls back to `rows[0]` — "the board's first
 * column" — when neither a "Backlog" status nor an `isDefault` one exists. Unordered, the
 * plan returns name order, so that fallback picked "AI Reviewed".
 */
export async function getProjectStatusesForVoiceCapture(
  projectId: string,
  database: Database = db,
): Promise<Array<{ id: string; name: string; isDefault: boolean }>> {
  return database
    .select({ id: projectStatuses.id, name: projectStatuses.name, isDefault: projectStatuses.isDefault })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId))
    .orderBy(projectStatuses.sortOrder);
}

/**
 * ORDER-DEPENDENT (#773). `findTargetStatus` falls back to a SUBSTRING match, so a spoken
 * "move #12 to review" matches both "In Review" and "AI Reviewed" and takes the FIRST row —
 * and on an unordered read the plan hands back name order, where "AI Reviewed" comes first.
 * The not-found path also renders the whole list back to the user ("Available: ..."), which
 * has to read like the board's columns. `listProjectStatusIdNames` orders unconditionally.
 */
export async function getProjectStatusNamesForVoiceCapture(
  projectId: string,
  database: Database = db,
): Promise<Array<{ id: string; name: string }>> {
  return listProjectStatusIdNames(projectId, database);
}

export async function getIssueByNumberForVoiceCapture(
  projectId: string,
  issueNumber: number,
  database: Database = db,
): Promise<{ id: string; issueNumber: number | null; title: string; currentNodeId: string | null } | undefined> {
  const rows = await database
    .select({ id: issues.id, issueNumber: issues.issueNumber, title: issues.title, currentNodeId: issues.currentNodeId })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.issueNumber, issueNumber)))
    .limit(1);
  return rows[0];
}

export async function setIssueStatus(
  issueId: string,
  statusId: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await transitionIssueStatus(database, issueId, statusId, { now });
}

export async function insertVoiceCaptureIssue(
  values: {
    id: string;
    issueNumber: number;
    title: string;
    description: string;
    priority: string;
    statusId: string;
    projectId: string;
    now: string;
  },
  database: Database = db,
): Promise<void> {
  await database.insert(issues).values({
    id: values.id,
    issueNumber: values.issueNumber,
    title: values.title,
    description: values.description,
    priority: values.priority,
    issueType: "task",
    skipAutoReview: false,
    estimate: null,
    sortOrder: 0,
    workflowTemplateId: null,
    statusId: values.statusId,
    projectId: values.projectId,
    createdAt: values.now,
    updatedAt: values.now,
  });
}

export async function attachVoiceCaptureTag(
  issueId: string,
  tagId: string,
  database: Database = db,
): Promise<void> {
  await database.insert(issueTags).values({
    id: randomUUID(),
    issueId,
    tagId,
  });
}
