import { randomUUID } from "node:crypto";
import { issues, issueTags, issueDependencies, issueArtifacts, workspaces } from "@agentic-kanban/shared/schema";
import { eq, and } from "drizzle-orm";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "./board-events.js";
import type { DependencyType } from "@agentic-kanban/shared/schema";
import {
  resolveNewIssueDefaults,
  getIssueProjectId,
  getIssueWorkspaces,
  getIssuesByProject,
  getIssueSummary as getIssueSummaryRepo,
  getIssueTags,
  assignTag as assignTagRepo,
  removeTag as removeTagRepo,
  getOutgoingDependencies,
  getIncomingDependencies,
  getIssueArtifacts,
  deleteArtifact as deleteArtifactRepo,
} from "../repositories/issue.repository.js";
import { deleteWorkspaceCascade } from "../repositories/workspace.repository.js";
import { enrichWorkspacesWithSessionData, wouldCreateCycle } from "./board-aggregation.service.js";

export class IssueError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT",
  ) {
    super(message);
  }
}

export interface CreateIssueInput {
  projectId: string;
  title: string;
  description?: string;
  priority?: string;
  issueType?: string;
  skipAutoReview?: boolean;
  estimate?: string | null;
  sortOrder?: number;
  statusId?: string;
}

export interface CreateIssueResult {
  id: string;
  issueNumber: number;
  title: string;
}

export function createIssueService(deps: {
  database: Database;
  boardEvents?: BoardEvents;
}) {
  const { database, boardEvents } = deps;

  async function createIssue(input: CreateIssueInput): Promise<CreateIssueResult> {
    const now = new Date().toISOString();
    const id = randomUUID();

    let issueNumber: number;
    let statusId: string;
    try {
      ({ issueNumber, statusId } = await resolveNewIssueDefaults(input.projectId, input.statusId, database));
    } catch (err: any) {
      if (err.statusCode === 400) throw new IssueError(err.message, "BAD_REQUEST");
      throw err;
    }

    await database.insert(issues).values({
      id,
      issueNumber,
      title: input.title,
      description: input.description ?? null,
      priority: input.priority ?? "medium",
      issueType: input.issueType ?? "task",
      skipAutoReview: input.skipAutoReview ?? false,
      estimate: input.estimate ?? null,
      sortOrder: input.sortOrder ?? 0,
      statusId,
      projectId: input.projectId,
      createdAt: now,
      updatedAt: now,
    });

    if (input.projectId) boardEvents?.broadcast(input.projectId, "issue_created");

    return { id, issueNumber, title: input.title };
  }

  async function updateIssue(
    id: string,
    body: Record<string, unknown>,
  ): Promise<{ id: string; projectId: string | null }> {
    const projectId = await getIssueProjectId(id, database);
    if (!projectId) throw new IssueError("Issue not found", "NOT_FOUND");

    const now = new Date().toISOString();

    const updates: Record<string, unknown> = { updatedAt: now };
    if (body.title !== undefined) updates.title = body.title;
    if (body.description !== undefined) updates.description = body.description;
    if (body.priority !== undefined) updates.priority = body.priority;
    if (body.issueType !== undefined) updates.issueType = body.issueType;
    if (body.statusId !== undefined) { updates.statusId = body.statusId; updates.statusChangedAt = now; }
    if (body.sortOrder !== undefined) updates.sortOrder = body.sortOrder;
    if (body.estimate !== undefined) updates.estimate = body.estimate;
    if (body.skipAutoReview !== undefined) updates.skipAutoReview = body.skipAutoReview;
    if (body.dueDate !== undefined) updates.dueDate = body.dueDate;

    await database.update(issues).set(updates).where(eq(issues.id, id));

    boardEvents?.broadcast(projectId, "issue_updated");

    return { id, projectId };
  }

  async function deleteIssue(id: string): Promise<string | null> {
    const projectId = await getIssueProjectId(id, database);
    if (!projectId) throw new IssueError("Issue not found", "NOT_FOUND");

    // Find all workspaces for this issue and cascade delete
    const wsRows = await database.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.issueId, id));
    for (const ws of wsRows) {
      await deleteWorkspaceCascade(ws.id, database);
    }

    await database.delete(issueTags).where(eq(issueTags.issueId, id));
    await database.delete(issueDependencies).where(eq(issueDependencies.issueId, id));
    await database.delete(issues).where(eq(issues.id, id));

    boardEvents?.broadcast(projectId, "issue_deleted");
    return projectId;
  }

  async function addDependency(
    issueId: string,
    dependsOnId: string,
    type?: string,
  ): Promise<{ id: string; type: string; projectId: string }> {
    if (dependsOnId === issueId) {
      throw new IssueError("An issue cannot depend on itself", "BAD_REQUEST");
    }

    const depType = (type || "depends_on") as DependencyType;
    const validTypes: string[] = ["depends_on", "blocked_by", "related_to", "duplicates", "parent_of", "child_of"];
    if (!validTypes.includes(depType)) {
      throw new IssueError(`Invalid dependency type. Must be one of: ${validTypes.join(", ")}`, "BAD_REQUEST");
    }

    const [sourceIssue, targetIssue] = await Promise.all([
      database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, issueId)).limit(1),
      database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, dependsOnId)).limit(1),
    ]);

    if (sourceIssue.length === 0) throw new IssueError("Issue not found", "NOT_FOUND");
    if (targetIssue.length === 0) throw new IssueError("Dependency target issue not found", "NOT_FOUND");
    if (sourceIssue[0].projectId !== targetIssue[0].projectId) {
      throw new IssueError("Cannot add dependencies across projects", "BAD_REQUEST");
    }

    if (depType === "depends_on" || depType === "blocked_by" || depType === "parent_of" || depType === "child_of") {
      const wouldCycle = await wouldCreateCycle(database, issueId, dependsOnId, sourceIssue[0].projectId);
      if (wouldCycle) {
        throw new IssueError("Adding this dependency would create a cycle", "CONFLICT");
      }
    }

    const id = randomUUID();
    try {
      await database.insert(issueDependencies).values({
        id,
        issueId,
        dependsOnId,
        type: depType,
        createdAt: new Date().toISOString(),
      });
    } catch (err: any) {
      if (err.message?.includes("UNIQUE constraint")) {
        throw new IssueError("This dependency already exists", "CONFLICT");
      }
      throw err;
    }

    boardEvents?.broadcast(sourceIssue[0].projectId, "dependency_added");
    return { id, type: depType, projectId: sourceIssue[0].projectId };
  }

  async function removeDependency(issueId: string, depId: string): Promise<string | null> {
    await database.delete(issueDependencies)
      .where(and(eq(issueDependencies.id, depId), eq(issueDependencies.issueId, issueId)));

    const projectId = await getIssueProjectId(issueId, database);
    if (projectId) boardEvents?.broadcast(projectId, "dependency_removed");
    return projectId;
  }

  async function addArtifact(
    issueId: string,
    body: { type: string; mimeType?: string; content: string; caption?: string; workspaceId?: string },
  ): Promise<{ id: string; projectId: string | null }> {
    const validTypes = ["image", "text", "link", "video"];
    if (!validTypes.includes(body.type)) {
      throw new IssueError(`type must be one of: ${validTypes.join(", ")}`, "BAD_REQUEST");
    }

    const id = randomUUID();
    await database.insert(issueArtifacts).values({
      id,
      issueId,
      workspaceId: body.workspaceId ?? null,
      type: body.type,
      mimeType: body.mimeType ?? null,
      content: body.content,
      caption: body.caption ?? null,
    });

    const projectId = await getIssueProjectId(issueId, database);
    if (projectId) boardEvents?.broadcast(projectId, "issue_updated");

    return { id, projectId };
  }

  async function getEnrichedWorkspaces(issueId: string) {
    const wsRows = await getIssueWorkspaces(issueId, database);
    const wsIds = wsRows.map(w => w.id);
    const { contextTokensMap, lastToolMap } = await enrichWorkspacesWithSessionData(wsIds, database);
    return wsRows.map(w => ({
      ...w,
      contextTokens: contextTokensMap.get(w.id) ?? null,
      lastTool: lastToolMap.get(w.id) ?? null,
    }));
  }

  async function listIssues(projectId: string, issueNumber?: number) {
    return getIssuesByProject(projectId, issueNumber, database);
  }

  async function getIssueSummary(idParam: string) {
    return getIssueSummaryRepo(idParam, database);
  }

  async function getTags(issueId: string) {
    return getIssueTags(issueId, database);
  }

  async function assignTag(issueId: string, tagId: string) {
    return assignTagRepo(issueId, tagId, database);
  }

  async function removeTag(issueId: string, tagId: string) {
    return removeTagRepo(issueId, tagId, database);
  }

  async function getDependencies(issueId: string) {
    const [outgoing, incoming] = await Promise.all([
      getOutgoingDependencies(issueId, database),
      getIncomingDependencies(issueId, database),
    ]);
    return { dependencies: [...outgoing, ...incoming] };
  }

  async function getArtifacts(issueId: string) {
    return getIssueArtifacts(issueId, database);
  }

  async function deleteArtifact(issueId: string, artifactId: string) {
    return deleteArtifactRepo(issueId, artifactId, database);
  }

  return {
    createIssue,
    updateIssue,
    deleteIssue,
    addDependency,
    removeDependency,
    addArtifact,
    deleteArtifact,
    getEnrichedWorkspaces,
    listIssues,
    getIssueSummary,
    getTags,
    assignTag,
    removeTag,
    getDependencies,
    getArtifacts,
  };
}
