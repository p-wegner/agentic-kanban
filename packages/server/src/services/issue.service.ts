import { randomUUID } from "node:crypto";
import { issues, issueTags, issueDependencies, issueArtifacts, issueComments, showdowns, workspaces, projectStatuses, workflowTemplates, workflowNodes, sessions } from "@agentic-kanban/shared/schema";
import { eq, and, or, sql, inArray, desc } from "drizzle-orm";
import { createDrive } from "../repositories/drive.repository.js";
import type { Database } from "../db/index.js";
import { withTransaction } from "../db/index.js";
import type { BoardEvents } from "./board-events.js";
import type { WebhookIssueStatusPayload } from "@agentic-kanban/shared/lib";
import type { DependencyType } from "@agentic-kanban/shared/schema";
import { getStartNode, resolveStatusId, syncCurrentNodeToStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { isTerminalStatusView } from "@agentic-kanban/shared";
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
  getIssueDescription,
} from "../repositories/issue.repository.js";
import { deleteWorkspaceCascade } from "../repositories/workspace.repository.js";
import { enrichWorkspacesWithSessionData, wouldCreateCycle } from "./board-aggregation.service.js";
import { materializePhaseArtifactToWorktree } from "./phase-artifacts.service.js";

function parseJsonArray<T>(raw: string | null | undefined, fallback: T[]): T[] {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as T[] : fallback;
  } catch {
    return fallback;
  }
}

export class IssueError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT",
  ) {
    super(message);
  }
}

/**
 * Validate an optional external-tracker URL: must be absent/null/empty, or a
 * well-formed http(s) URL. Returns the trimmed URL (or null). Throws IssueError
 * (BAD_REQUEST) for any other scheme or malformed value so links can be opened
 * safely in a new tab without smuggling javascript:/data: payloads.
 */
export function validateExternalUrl(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new IssueError("externalUrl must be a string", "BAD_REQUEST");
  }
  const trimmed = value.trim();
  if (trimmed === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new IssueError("externalUrl must be a valid URL", "BAD_REQUEST");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new IssueError("externalUrl must use http or https", "BAD_REQUEST");
  }
  return trimmed;
}

function normalizeExternalKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new IssueError("externalKey must be a string", "BAD_REQUEST");
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
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
  externalKey?: string | null;
  externalUrl?: string | null;
}

export type CreateIssueResult = NonNullable<Awaited<ReturnType<typeof getIssueDescription>>>;

export type WebhookSender = (projectId: string, payload: WebhookIssueStatusPayload) => void;

export function createIssueService(deps: {
  database: Database;
  boardEvents?: BoardEvents;
  sendWebhook?: WebhookSender;
}) {
  const { database, boardEvents, sendWebhook } = deps;

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

    const externalKey = normalizeExternalKey(input.externalKey);
    const externalUrl = validateExternalUrl(input.externalUrl);

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
      externalKey,
      externalUrl,
      currentNodeId: workflowDefaults.currentNodeId,
      statusId: workflowDefaults.statusId,
      projectId: input.projectId,
      createdAt: now,
      updatedAt: now,
    });

    if (input.projectId) boardEvents?.broadcast(input.projectId, "issue_created");

    return (await getIssueDescription(id, database))!;
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
    opts?: {
      /** When set, each created issue gets a child_of edge pointing at this parent. */
      parentIssueId?: string;
      /** When set (requires parentIssueId), a Drive record is created with metaIssueId=parentIssueId. */
      driveTarget?: string;
    },
  ): Promise<{ issues: CreateIssueResult[]; driveId?: string }> {
    if (inputs.length === 0) return { issues: [] };

    for (let i = 0; i < inputs.length; i++) {
      if (!inputs[i].title || !inputs[i].title.trim()) {
        const err = new IssueError(`issues[${i}].title is required`, "BAD_REQUEST") as any;
        err.index = i;
        throw err;
      }
    }

    const results: string[] = await withTransaction(database, async (tx) => {
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
      const insertedIds: string[] = [];
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
        if (opts?.parentIssueId) {
          await tx.insert(issueDependencies).values({
            id: randomUUID(),
            issueId: id,
            dependsOnId: opts.parentIssueId,
            type: "child_of",
            createdAt: now,
          });
        }
        insertedIds.push(id);
      }
      return insertedIds;
    });

    const out: CreateIssueResult[] = [];
    for (const id of results) {
      out.push((await getIssueDescription(id, database))!);
    }
    boardEvents?.broadcast(projectId, "issue_created");

    let driveId: string | undefined;
    if (opts?.parentIssueId && opts.driveTarget) {
      const drive = await createDrive(
        { projectId, metaIssueId: opts.parentIssueId, target: opts.driveTarget },
        database,
      );
      driveId = drive.id;
    }

    return { issues: out, driveId };
  }

  async function updateIssue(
    id: string,
    body: Record<string, unknown>,
  ): Promise<CreateIssueResult> {
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
    if (body.externalKey !== undefined) updates.externalKey = normalizeExternalKey(body.externalKey);
    if (body.externalUrl !== undefined) updates.externalUrl = validateExternalUrl(body.externalUrl);
    if (body.workflowTemplateId !== undefined) updates.workflowTemplateId = body.workflowTemplateId;
    if (body.checklist !== undefined) updates.checklistJson = body.checklist === null ? null : JSON.stringify(body.checklist);
    if (body.pinned !== undefined) updates.pinned = body.pinned;
    if (body.milestoneId !== undefined) updates.milestoneId = body.milestoneId ?? null;

    // Capture issue number before update for webhook payload
    let issueNumberForWebhook: number | null = null;
    let issueTitleForWebhook = "";

    // Capture pre-update terminal-ness so we only act on a transition INTO a
    // terminal status (Done/Cancelled/Archived), not on every update of an
    // already-terminal issue.
    let wasTerminal = false;
    if (body.statusId !== undefined) {
      const beforeRow = await database
        .select({
          issueNumber: issues.issueNumber,
          title: issues.title,
          statusId: issues.statusId,
          statusName: projectStatuses.name,
          currentNodeId: issues.currentNodeId,
        })
        .from(issues)
        .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
        .where(eq(issues.id, id))
        .limit(1);
      if (beforeRow[0]) {
        issueNumberForWebhook = beforeRow[0].issueNumber;
        issueTitleForWebhook = beforeRow[0].title;
        wasTerminal = isTerminalStatusView({
          statusName: beforeRow[0].statusName,
          currentNodeId: beforeRow[0].currentNodeId,
        });
      }
    }

    await database.update(issues).set(updates).where(eq(issues.id, id));

    // If a manual status change moved an issue that runs a workflow, keep its
    // currentNode consistent with the new board status (#78 status-as-view).
    if (body.statusId !== undefined) {
      await syncCurrentNodeToStatus(database, id).catch(() => {});
    }

    // Resolve the new status name once; reused for the terminal-transition check
    // below and the webhook payload.
    let newStatusName: string | null = null;
    if (body.statusId !== undefined) {
      const statusRow = await database
        .select({ name: projectStatuses.name })
        .from(projectStatuses)
        .where(eq(projectStatuses.id, body.statusId as string))
        .limit(1);
      newStatusName = statusRow[0]?.name ?? null;
    }

    // When an issue transitions INTO a terminal status (Done/Cancelled/Archived),
    // close any still-open workspace for it. Otherwise the in-process monitor keeps
    // trying to relaunch the now-pointless idle workspace every cycle (#776). Only
    // act on the non-terminal -> terminal edge so re-saving an already-Done issue is
    // a no-op. We use a direct DB status update (mirroring close_workspace / merge's
    // terminal "closed" state) rather than importing the workspace service, to avoid
    // an import cycle; downstream worktree cleanup is handled on the next reconcile.
    if (body.statusId !== undefined && !wasTerminal) {
      const afterRow = await database
        .select({ currentNodeId: issues.currentNodeId, currentNodeType: workflowNodes.nodeType })
        .from(issues)
        .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
        .where(eq(issues.id, id))
        .limit(1);
      const nowTerminal = isTerminalStatusView({
        statusName: newStatusName,
        currentNodeId: afterRow[0]?.currentNodeId ?? null,
        currentNodeType: afterRow[0]?.currentNodeType ?? null,
      });
      if (nowTerminal) {
        const closedAt = new Date().toISOString();
        await database
          .update(workspaces)
          .set({ status: "closed", closedAt, updatedAt: closedAt })
          .where(and(eq(workspaces.issueId, id), sql`${workspaces.status} != 'closed'`));
      }
    }

    if (body.statusId !== undefined && sendWebhook) {
      sendWebhook(projectId, {
        event: "issue.status_changed",
        issueId: id,
        issueNumber: issueNumberForWebhook,
        title: issueTitleForWebhook,
        projectId,
        newStatusId: body.statusId as string,
        newStatusName: newStatusName,
        statusChangedAt: now,
      });
    }

    boardEvents?.broadcast(projectId, "issue_updated");

    return (await getIssueDescription(id, database))!;
  }

  async function updateIssuesBulk(
    ids: string[],
    body: Record<string, unknown>,
  ): Promise<{ updated: number; projectId: string }> {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new IssueError("issueIds must be a non-empty array", "BAD_REQUEST");
    }

    const rows = await database
      .select({ id: issues.id, projectId: issues.projectId })
      .from(issues)
      .where(inArray(issues.id, ids));

    if (rows.length !== new Set(ids).size) {
      throw new IssueError("One or more issues were not found", "NOT_FOUND");
    }

    const projectIds = new Set(rows.map((row) => row.projectId));
    if (projectIds.size !== 1) {
      throw new IssueError("Cannot bulk-update issues across projects", "BAD_REQUEST");
    }

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
    if (body.externalKey !== undefined) updates.externalKey = normalizeExternalKey(body.externalKey);
    if (body.externalUrl !== undefined) updates.externalUrl = validateExternalUrl(body.externalUrl);
    if (body.workflowTemplateId !== undefined) updates.workflowTemplateId = body.workflowTemplateId;

    const uniqueIds = [...new Set(ids)];
    await database.update(issues).set(updates).where(inArray(issues.id, uniqueIds));

    if (body.statusId !== undefined) {
      await Promise.all(uniqueIds.map((id) => syncCurrentNodeToStatus(database, id).catch(() => {})));
    }

    const projectId = rows[0].projectId;
    boardEvents?.broadcast(projectId, "issue_updated");

    return { updated: uniqueIds.length, projectId };
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
      const isUnique =
        err.message?.includes("UNIQUE constraint") ||
        err.cause?.message?.includes("UNIQUE constraint") ||
        err.code === "SQLITE_CONSTRAINT_UNIQUE" ||
        err.cause?.code === "SQLITE_CONSTRAINT_UNIQUE";
      if (isUnique) {
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

    await withTransaction(database, async (tx) => {
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

    if (body.type === "text") {
      await materializePhaseArtifactToWorktree(database, {
        issueId,
        workspaceId: body.workspaceId,
        caption: body.caption,
        content: body.content,
      });
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

    // Fetch latest session per workspace for lastSessionAt / sessionStatus
    const sessionRows = wsIds.length > 0
      ? await database
          .select({
            workspaceId: sessions.workspaceId,
            status: sessions.status,
            startedAt: sessions.startedAt,
            endedAt: sessions.endedAt,
            triggerType: sessions.triggerType,
          })
          .from(sessions)
          .where(inArray(sessions.workspaceId, wsIds))
          .orderBy(desc(sessions.startedAt))
      : [];
    const latestSessionByWs = new Map<string, typeof sessionRows[0]>();
    for (const s of sessionRows) {
      if (!latestSessionByWs.has(s.workspaceId)) latestSessionByWs.set(s.workspaceId, s);
    }

    return wsRows.map(w => {
      const {
        latestSetupCommand,
        latestSetupState,
        latestSetupStartedAt,
        latestSetupEndedAt,
        latestSetupExitCode,
        latestSetupDurationMs,
        latestSetupStdoutTail,
        latestSetupStderrTail,
        latestSymlinkState,
        latestSymlinkStartedAt,
        latestSymlinkEndedAt,
        latestSymlinkDirs,
        latestSymlinkLinked,
        latestSymlinkSkipped,
        latestSymlinkFailed,
        latestSymlinkError,
        conflictCacheHasConflicts,
        conflictCacheFiles,
        diffStatCacheFilesChanged,
        diffStatCacheInsertions,
        diffStatCacheDeletions,
        scorecardScore,
        ...workspace
      } = w;
      const conflicts = conflictCacheHasConflicts !== null && conflictCacheHasConflicts !== undefined
        ? {
            hasConflicts: conflictCacheHasConflicts,
            conflictingFiles: parseJsonArray<string>(conflictCacheFiles, []),
          }
        : null;
      const diffStats = diffStatCacheFilesChanged !== null && diffStatCacheFilesChanged !== undefined
        ? {
            filesChanged: diffStatCacheFilesChanged,
            insertions: diffStatCacheInsertions ?? 0,
            deletions: diffStatCacheDeletions ?? 0,
          }
        : null;
      const sess = latestSessionByWs.get(w.id);
      return {
        ...workspace,
        conflicts,
        diffStats,
        scorecard: scorecardScore !== null && scorecardScore !== undefined ? { score: scorecardScore } : null,
        lastSessionAt: sess ? (sess.status === "running" ? sess.startedAt : sess.endedAt) : null,
        sessionStatus: sess?.status ?? null,
        lastSessionTriggerType: sess?.triggerType ?? null,
        latestSetup: latestSetupState ? {
          command: latestSetupCommand,
          state: latestSetupState,
          startedAt: latestSetupStartedAt,
          endedAt: latestSetupEndedAt,
          exitCode: latestSetupExitCode,
          durationMs: latestSetupDurationMs,
          stdoutTail: latestSetupStdoutTail,
          stderrTail: latestSetupStderrTail,
        } : null,
        latestSymlink: latestSymlinkState ? {
          state: latestSymlinkState,
          dirs: parseJsonArray<string>(latestSymlinkDirs, []),
          linked: parseJsonArray<string>(latestSymlinkLinked, []),
          skipped: parseJsonArray<string>(latestSymlinkSkipped, []),
          failed: parseJsonArray<{ dir: string; error: string }>(latestSymlinkFailed, []),
          startedAt: latestSymlinkStartedAt,
          endedAt: latestSymlinkEndedAt,
          error: latestSymlinkError,
        } : null,
        contextTokens: contextTokensMap.get(w.id) ?? null,
        lastTool: lastToolMap.get(w.id) ?? null,
      };
    });
  }

  async function listIssues(
    projectId: string,
    issueNumber?: number,
    statusName?: string,
    opts?: { excludeDescription?: boolean },
  ) {
    return getIssuesByProject(projectId, issueNumber, database, statusName, opts);
  }

  async function getIssueSummary(idParam: string) {
    return getIssueSummaryRepo(idParam, database);
  }

  async function getTags(issueId: string) {
    return getIssueTags(issueId, database);
  }

  async function assignTag(issueId: string, tagId: string) {
    const result = await assignTagRepo(issueId, tagId, database);
    const projectId = await getIssueProjectId(issueId, database);
    if (projectId) boardEvents?.broadcast(projectId, "issue_updated");
    return result;
  }

  async function removeTag(issueId: string, tagId: string) {
    const result = await removeTagRepo(issueId, tagId, database);
    const projectId = await getIssueProjectId(issueId, database);
    if (projectId) boardEvents?.broadcast(projectId, "issue_updated");
    return result;
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

  async function duplicateIssue(sourceId: string): Promise<CreateIssueResult> {
    const rows = await database
      .select({
        projectId: issues.projectId,
        title: issues.title,
        description: issues.description,
        priority: issues.priority,
        issueType: issues.issueType,
      })
      .from(issues)
      .where(eq(issues.id, sourceId))
      .limit(1);

    if (rows.length === 0) throw new IssueError("Issue not found", "NOT_FOUND");
    const source = rows[0];

    const newIssue = await createIssue({
      projectId: source.projectId,
      title: `Copy of ${source.title}`,
      description: source.description ?? undefined,
      priority: source.priority ?? undefined,
      issueType: source.issueType ?? undefined,
    });

    const sourceTags = await getIssueTags(sourceId, database);
    for (const tag of sourceTags) {
      await assignTagRepo(newIssue.id, tag.id, database);
    }

    return newIssue;
  }

  async function archiveDoneIssues(
    projectId: string,
    olderThanDays: number,
    nowOverride?: string,
  ): Promise<{ archived: number }> {
    if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
      throw new IssueError("olderThanDays must be a positive number", "BAD_REQUEST");
    }

    const archivedStatus = await database
      .select({ id: projectStatuses.id })
      .from(projectStatuses)
      .where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.name, "Archived")))
      .limit(1);

    if (archivedStatus.length === 0) {
      throw new IssueError("Archived status not found for this project", "NOT_FOUND");
    }
    const archivedStatusId = archivedStatus[0].id;

    const doneStatuses = await database
      .select({ id: projectStatuses.id })
      .from(projectStatuses)
      .where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.name, "Done")));

    if (doneStatuses.length === 0) {
      return { archived: 0 };
    }
    const doneStatusIds = doneStatuses.map((s) => s.id);

    const cutoff = new Date(
      new Date(nowOverride ?? new Date().toISOString()).getTime() - olderThanDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const candidates = await database
      .select({ id: issues.id, statusChangedAt: issues.statusChangedAt, createdAt: issues.createdAt })
      .from(issues)
      .where(and(eq(issues.projectId, projectId), inArray(issues.statusId, doneStatusIds)));

    const toArchive = candidates
      .filter((i) => {
        const ts = i.statusChangedAt ?? i.createdAt;
        return ts < cutoff;
      })
      .map((i) => i.id);

    if (toArchive.length === 0) {
      return { archived: 0 };
    }

    const now = new Date().toISOString();
    await database
      .update(issues)
      .set({ statusId: archivedStatusId, statusChangedAt: now, updatedAt: now })
      .where(inArray(issues.id, toArchive));

    boardEvents?.broadcast(projectId, "issue_updated");

    return { archived: toArchive.length };
  }

  return {
    createIssue,
    createIssuesBatch,
    updateDependenciesBatch,
    updateIssue,
    updateIssuesBulk,
    deleteIssue,
    addDependency,
    removeDependency,
    addArtifact,
    deleteArtifact,
    archiveDoneIssues,
    getEnrichedWorkspaces,
    listIssues,
    getIssueSummary,
    getTags,
    assignTag,
    removeTag,
    getDependencies,
    getArtifacts,
    duplicateIssue,
  };
}
