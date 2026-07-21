import { projectStatuses } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { transitionIssueStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { resolveProjectId } from "./workspace-project-resolution.repository.js";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";

type WorkflowDbLike = Parameters<typeof transitionIssueStatus>[0];

/**
 * Move the issue associated with a workspace to "Done" (or "AI Reviewed" as fallback).
 * Logs a warning on failure but never throws.
 */
export async function moveIssueToDone(
  workspaceId: string,
  issueId: string,
  now: string,
  database: Database = db,
  fallbackToAiReviewed = false,
): Promise<void> {
  try {
    const projectId = await resolveProjectId(workspaceId, database);
    if (!projectId) return;
    const statuses = await database.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
    const doneStatus = statuses.find(s => s.name === "Done")
      ?? (fallbackToAiReviewed ? statuses.find(s => s.name === "AI Reviewed") : undefined);
    if (doneStatus) {
      await transitionIssueStatus(database, issueId, doneStatus.id, { now });
    }
  } catch (err) {
    console.warn("[workspaces] Failed to move issue to Done:", err);
  }
}

/**
 * Move the issue to "In Progress" when a workspace is created.
 * Logs a warning on failure but never throws.
 */
export async function moveIssueToInProgress(
  issueId: string,
  projectId: string,
  now: string,
  database: Database = db,
): Promise<void> {
  try {
    const statuses = await database.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
    const inProgress = statuses.find(s => s.name === "In Progress");
    if (inProgress) {
      await transitionIssueStatus(database, issueId, inProgress.id, { now });
    }
  } catch (err) {
    console.warn("[workspaces] Failed to move issue to In Progress:", err);
  }
}

/**
 * Transaction-safe variant for workspace creation. Unlike moveIssueToInProgress,
 * this throws so callers inside a transaction can roll back the workspace insert.
 */
export async function moveIssueToInProgressStrict(
  issueId: string,
  projectId: string,
  now: string,
  database: Database | TransactionClient = db,
): Promise<void> {
  const statuses = await database.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
  const inProgress = statuses.find(s => s.name === "In Progress");
  if (!inProgress) {
    throw new Error(`Project ${projectId} has no In Progress status`);
  }
  // A TransactionClient is structurally a WorkflowDb for the select/update calls
  // transitionIssueStatus makes; the node sync participates in the caller's tx.
  await transitionIssueStatus(database as WorkflowDbLike, issueId, inProgress.id, { now });
}
