import { randomUUID } from "node:crypto";
import { issues, issueTags, issueDependencies, issueArtifacts, issueComments, showdowns, workspaces, projectStatuses, workflowTemplates } from "@agentic-kanban/shared/schema";
import { eq, and, or, sql, inArray } from "drizzle-orm";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "./board-events.js";
import type { DependencyType } from "@agentic-kanban/shared/schema";
import { getStartNode, resolveStatusId, syncCurrentNodeToStatus } from "@agentic-kanban/shared/lib/workflow-engine";
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
import { materializePhaseArtifactToWorktree } from "./phase-artifacts.service.js";

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
  workflowTemplateId?: string | null;
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

    const workflowDefaults = input.workflowTemplateId
      ? await resolveInitialWorkflowState(input.projectId, input.workflowTemplateId, statusId)
      : { currentNodeId: null, statusId };

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
      workflowTemplateId: input.workflowTemplateId ?? null,
      currentNodeId: workflowDefaults.currentNodeId,
      statusId: workflowDefaults.statusId,
      projectId: input.projectId,
      createdAt: now,
      updatedAt: now,
    });

    if (input.projectId) boardEvents?.broadcast(input.projectId, "issue_created");

    return { id, issueNumber, title: input.title };
  }

  async function resolveInitialWorkflowState(
    projectId: string,
    templateId: string,
    fallbackStatusId: string,
  ): Promise<{ currentNodeId: string | null; statusId: string }> {
    const templateRows = await database
      .select({ id: workflowTemplates.id, projectId: workflowTemplates.projectId })
      .from(workflowTemplates)
      .where(eq(workflowTemplates.id, templateId))
      .limit(1);
    const template = templateRows[0];
    if (!template || (template.projectId !== null && template.projectId !== projectId)) {
      throw new IssueError("Workflow template not found for project", "BAD_REQUEST");
    }

    const startNode = await getStartNode(database as any, templateId);
    if (!startNode) return { currentNodeId: null, statusId: fallbackStatusId };
    const mappedStatusId = startNode.statusName
      ? await resolveStatusId(database as any, projectId, startNode.statusName)
      : null;
    return {
      currentNodeId: startNode.id,
      statusId: mappedStatusId ?? fallbackStatusId,
    };
  }

  async function createIssuesBatch(
    projectId: string,
    inputs: Omit<CreateIssueInput, "projectId">[],
  ): Promise<CreateIssueResult[]> {
    if (inputs.length === 0) return [];

    for (let i = 0; i < inputs.length; i++) {
      if (!inputs[i].title || !inputs[i].title.trim()) {
        const err = new IssueError(`issues[${i}].title is required`, "BAD_REQUEST") as any;
        err.index = i;
        throw err;
      }
    }

    const results: CreateIssueResult[] = await database.transaction(async (tx) => {
      const maxRow = await tx
        .select({ maxNum: sql<number | null>`max(${issues.issueNumber})` })
        .from(issues)
        .where(eq(issues.projectId, projectId));
      let nextNumber = (maxRow[0]?.maxNum ?? 0) + 1;

      const defaultStatusRows = await tx
        .select({ id: projectStatuses.id })
        .from(projectStatuses)
        .where(eq(projectStatuses.projectId, projectId))
        .limit(1);
      if (defaultStatusRows.length === 0) {
        const err = new IssueError("No statuses found for project", "BAD_REQUEST");
        throw err;
      }
      const defaultStatusId = defaultStatusRows[0].id;

      const now = new Date().toISOString();
      const out: CreateIssueResult[] = [];
      for (const input of inputs) {
        const id = randomUUID();
        const issueNumber = nextNumber++;
        await tx.insert(issues).values({
          id,
          issueNumber,
          title: input.title,
          description: input.description ?? null,
          priority: input.priority ?? "medium",
          issueType: input.issueType ?? "task",
          skipAutoReview: input.skipAutoReview ?? false,
          estimate: input.estimate ?? null,
          sortOrder: input.sortOrder ?? 0,
          statusId: input.statusId ?? defaultStatusId,
          projectId,
          createdAt: now,
          updatedAt: now,
        });
        out.push({ id, issueNumber, title: input.title });
      }
      return out;
    });

    boardEvents?.broadcast(projectId, "issue_created");
    return results;
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
    if (body.workflowTemplateId !== undefined) updates.workflowTemplateId = body.workflowTemplateId;

    await database.update(issues).set(updates).where(eq(issues.id, id));

    // If a manual status change moved an issue that runs a workflow, keep its
    // currentNode consistent with the new board status (#78 status-as-view).
    if (body.statusId !== undefined) {
      await syncCurrentNodeToStatus(database, id).catch(() => {});
    }

    boardEvents?.broadcast(projectId, "issue_updated");

    return { id, projectId };
  }

  async function deleteIssue(id: string): Promise<string | null> {
    const projectId = await getIssueProjectId(id, database);
    if (!projectId) throw new IssueError("Issue not found", "NOT_FOUND");

    // These rows can point at both the issue and its workspaces, so remove them
    // before deleting workspace rows.
    await database.delete(issueArtifacts).where(eq(issueArtifacts.issueId, id));
    await database.delete(issueComments).where(eq(issueComments.issueId, id));

    // Find all workspaces for this issue and cascade delete
    const wsRows = await database.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.issueId, id));
    for (const ws of wsRows) {
      await deleteWorkspaceCascade(ws.id, database);
    }

    await database.delete(issueTags).where(eq(issueTags.issueId, id));
    await database.delete(issueDependencies).where(or(eq(issueDependencies.issueId, id), eq(issueDependencies.dependsOnId, id)));
    await database.delete(showdowns).where(eq(showdowns.issueId, id));
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

  async function updateDependenciesBatch(
    edges: { issueId: string; dependsOnId: string; type?: string; action: "add" | "remove" }[],
  ): Promise<{
    added: number;
    removed: number;
    skipped: { edge: typeof edges[number]; reason: string }[];
    projectIds: string[];
  }> {
    const VALID_TYPES = ["depends_on", "blocked_by", "related_to", "duplicates", "parent_of", "child_of"];
    const DIRECTIONAL = new Set(["depends_on", "blocked_by", "parent_of", "child_of"]);

    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (!e.issueId || !e.dependsOnId) {
        const err = new IssueError(`edges[${i}]: issueId and dependsOnId are required`, "BAD_REQUEST") as any;
        err.index = i;
        throw err;
      }
      if (e.action !== "add" && e.action !== "remove") {
        const err = new IssueError(`edges[${i}]: action must be 'add' or 'remove'`, "BAD_REQUEST") as any;
        err.index = i;
        throw err;
      }
      if (e.action === "add" && e.issueId === e.dependsOnId) {
        const err = new IssueError(`edges[${i}]: an issue cannot depend on itself`, "BAD_REQUEST") as any;
        err.index = i;
        throw err;
      }
      if (e.type && !VALID_TYPES.includes(e.type)) {
        const err = new IssueError(`edges[${i}]: invalid type`, "BAD_REQUEST") as any;
        err.index = i;
        throw err;
      }
    }

    const skipped: { edge: typeof edges[number]; reason: string }[] = [];
    const touchedProjectIds = new Set<string>();
    let added = 0;
    let removed = 0;

    await database.transaction(async (tx) => {
      const issueIds = [...new Set(edges.flatMap(e => [e.issueId, e.dependsOnId]))];
      const issueRows = issueIds.length === 0 ? [] : await tx
        .select({ id: issues.id, projectId: issues.projectId })
        .from(issues)
        .where(inArray(issues.id, issueIds));
      const projectByIssue = new Map(issueRows.map(r => [r.id, r.projectId]));

      const projectIds = [...new Set(issueRows.map(r => r.projectId))];
      const allDepRows = projectIds.length === 0
        ? []
        : await tx
            .select({
              id: issueDependencies.id,
              issueId: issueDependencies.issueId,
              dependsOnId: issueDependencies.dependsOnId,
              type: issueDependencies.type,
              projectId: issues.projectId,
            })
            .from(issueDependencies)
            .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
            .where(inArray(issues.projectId, projectIds));

      const adjByProject = new Map<string, Map<string, Set<string>>>();
      const edgeKeyToRow = new Map<string, { id: string; projectId: string }>();
      for (const dep of allDepRows) {
        if (DIRECTIONAL.has(dep.type)) {
          let adj = adjByProject.get(dep.projectId);
          if (!adj) { adj = new Map(); adjByProject.set(dep.projectId, adj); }
          let set = adj.get(dep.issueId);
          if (!set) { set = new Set(); adj.set(dep.issueId, set); }
          set.add(dep.dependsOnId);
        }
        edgeKeyToRow.set(`${dep.issueId}|${dep.dependsOnId}|${dep.type}`, { id: dep.id, projectId: dep.projectId });
      }

      const hasPath = (adj: Map<string, Set<string>>, from: string, to: string): boolean => {
        const visited = new Set<string>();
        const stack = [from];
        while (stack.length) {
          const cur = stack.pop()!;
          if (cur === to) return true;
          if (visited.has(cur)) continue;
          visited.add(cur);
          const ns = adj.get(cur);
          if (ns) for (const n of ns) stack.push(n);
        }
        return false;
      };

      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const type = e.type ?? "depends_on";
        const srcProj = projectByIssue.get(e.issueId);
        const tgtProj = projectByIssue.get(e.dependsOnId);

        if (e.action === "add") {
          if (!srcProj) { skipped.push({ edge: e, reason: "source issue not found" }); continue; }
          if (!tgtProj) { skipped.push({ edge: e, reason: "target issue not found" }); continue; }
          if (srcProj !== tgtProj) { skipped.push({ edge: e, reason: "cross-project dependency" }); continue; }

          const key = `${e.issueId}|${e.dependsOnId}|${type}`;
          if (edgeKeyToRow.has(key)) { skipped.push({ edge: e, reason: "already exists" }); continue; }

          if (DIRECTIONAL.has(type)) {
            let adj = adjByProject.get(srcProj);
            if (!adj) { adj = new Map(); adjByProject.set(srcProj, adj); }
            // Would adding issueId -> dependsOnId create a cycle? Cycle iff path dependsOnId -> issueId already.
            if (hasPath(adj, e.dependsOnId, e.issueId)) {
              const err = new IssueError(
                `edges[${i}]: adding dependency ${e.issueId} -> ${e.dependsOnId} would create a cycle`,
                "CONFLICT",
              ) as any;
              err.index = i;
              throw err;
            }
            let set = adj.get(e.issueId);
            if (!set) { set = new Set(); adj.set(e.issueId, set); }
            set.add(e.dependsOnId);
          }

          const id = randomUUID();
          await tx.insert(issueDependencies).values({
            id,
            issueId: e.issueId,
            dependsOnId: e.dependsOnId,
            type: type as DependencyType,
            createdAt: new Date().toISOString(),
          });
          edgeKeyToRow.set(key, { id, projectId: srcProj });
          touchedProjectIds.add(srcProj);
          added++;
        } else {
          const key = `${e.issueId}|${e.dependsOnId}|${type}`;
          const row = edgeKeyToRow.get(key);
          if (!row) { skipped.push({ edge: e, reason: "dependency does not exist" }); continue; }
          await tx.delete(issueDependencies).where(eq(issueDependencies.id, row.id));
          edgeKeyToRow.delete(key);
          if (DIRECTIONAL.has(type)) {
            const adj = adjByProject.get(row.projectId);
            adj?.get(e.issueId)?.delete(e.dependsOnId);
          }
          touchedProjectIds.add(row.projectId);
          removed++;
        }
      }
    });

    for (const pid of touchedProjectIds) {
      boardEvents?.broadcast(pid, added > 0 ? "dependency_added" : "dependency_removed");
    }

    return { added, removed, skipped, projectIds: [...touchedProjectIds] };
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

    if (body.type === "text") {
      await materializePhaseArtifactToWorktree(database, {
        issueId,
        workspaceId: body.workspaceId,
        caption: body.caption,
        content: body.content,
      }).catch((err) => console.warn("[issue-artifacts] failed to write phase artifact file:", err));
    }

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
    createIssuesBatch,
    updateDependenciesBatch,
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
