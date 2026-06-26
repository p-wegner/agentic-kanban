import { isTerminalStatusName, isTerminalStatusView } from "@agentic-kanban/shared";
import type { WebhookIssueStatusPayload } from "@agentic-kanban/shared/lib";
import { buildIssueStatusPayload } from "@agentic-kanban/shared/lib";
import { syncCurrentNodeToStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { type DependencyType } from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/index.js";
import { withTransaction } from "../db/index.js";
import { planContraction, resolveCoupledComponent } from "../lib/dependency-graph.js";
import { openWorkspaceBlockMessage } from "../lib/terminal-move-guard.js";
import { parseJsonArray } from "../lib/workspace-details-projection.js";
import { createDrive } from "../repositories/drive.repository.js";
import {
    appendIssueDescription,
    countOpenWorkspacesForIssues,
    getIssuesForContract,
    getStatusIdByName,
    setIssueStatus,
    updateIssueTitleDescription,
} from "../repositories/issue-ai.repository.js";
import { isIssueNumberUniqueConstraintError, nextIssueNumber } from "../repositories/issue-number.repository.js";
import {
    archiveIssuesByIds,
    closeOpenWorkspacesForIssue,
    deleteIssueCascade,
    getArchivedStatusId,
    getDependencyRowsForProjects,
    getDoneCandidateIssues,
    getDoneStatusIds,
    getDuplicateSourceIssue,
    getFirstProjectStatusId,
    getIssueCurrentNodeInfo,
    getIssueIdsAndProjects,
    getIssueWebhookSnapshot,
    getLatestSessionsForWorkspaces,
    getProjectStatusName,
    getWorkflowTemplateForProject,
    insertBatchIssue,
    insertDependency,
    insertIssue,
    insertIssueArtifact,
    updateIssueById,
    updateIssuesByIds
} from "../repositories/issue-service.repository.js";
import {
    assignTag as assignTagRepo,
    deleteArtifact as deleteArtifactRepo,
    getIssueArtifacts,
    getIssueDescription,
    getIssueProjectId,
    getIssuesByProject,
    getIssueSummary as getIssueSummaryRepo,
    getIssueTags,
    getIssueWorkspaces,
    removeTag as removeTagRepo,
    resolveNewIssueDefaults
} from "../repositories/issue.repository.js";
import { findOpenUnmergedWorkspace } from "../repositories/workspace.repository.js";
import { enrichWorkspacesWithSessionData } from "./board-aggregation.service.js";
import type { BoardEvents } from "./board-events.js";
import { createIssueDependencyService, validateBatchDependencies } from "./issue-dependency.service.js";
import { IssueError } from "./issue-error.js";
import { materializePhaseArtifactToWorktree } from "./phase-artifacts.service.js";

// IssueError lives in its own module to avoid an import cycle with the dependency
// sub-service; re-exported here so existing consumers' imports are unchanged.
export { IssueError } from "./issue-error.js";
// validateBatchDependencies moved alongside the dependency sub-service it belongs
// with; re-exported for back-compat (routes + tests import it from here).
export { validateBatchDependencies } from "./issue-dependency.service.js";

const ISSUE_NUMBER_INSERT_ATTEMPTS = 3;

type ContractIssueRow = {
  id: string;
  issueNumber: number;
  title: string;
  description: string | null;
};

function contractPointer(leadIssueNumber: number): string {
  return `> Absorbed into #${leadIssueNumber} - combined into one coupled ticket.`;
}

function buildCombinedDescription(leadId: string, members: ContractIssueRow[]): string {
  const sorted = [...members].sort((a, b) => {
    if (a.id === leadId) return -1;
    if (b.id === leadId) return 1;
    return a.issueNumber - b.issueNumber;
  });
  return [
    "## Combined Coupled Ticket Sources",
    "",
    ...sorted.map((member) => [
      `### From #${member.issueNumber}: ${member.title}`,
      "",
      member.description?.trim() || "(no description)",
    ].join("\n")),
  ].join("\n");
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

/**
 * A dependency edge seeded alongside a batch create, referenced by the 0-based index
 * of each issue in the `issues` array (the IDs are generated inside the call). This is
 * the REST/butler-side mirror of the `create_issues_batch` MCP tool's `dependencies`
 * input — the SAME mechanism the analyzer writes — so a generating agent can DECLARE
 * coupling (`coupled_with`) at creation rather than have it reconstructed later (#918).
 */
export interface BatchDependencyInput {
  issueIndex: number;
  dependsOnIndex: number;
  type?: DependencyType;
}

export type WebhookSender = (projectId: string, payload: WebhookIssueStatusPayload) => void;

/**
 * Build the column updates SHARED by single-issue and bulk-issue updates from a PATCH
 * body. Pure (no DB) so it is unit-testable and so the two write paths can never drift
 * on these fields again — previously this block was duplicated verbatim in updateIssue
 * and updateIssuesBulk. Caller-specific fields stay with the caller: updateIssue layers
 * on checklist/pinned/milestoneId after calling this; those are intentionally NOT part
 * of bulk update.
 */
export function buildSharedIssueUpdate(
  body: Record<string, unknown>,
  now: string,
): Record<string, unknown> {
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
  return updates;
}

export function createIssueService(deps: {
  database: Database;
  boardEvents?: BoardEvents;
  sendWebhook?: WebhookSender;
}) {
  const { database, boardEvents, sendWebhook } = deps;
  // Dependency-management methods live in their own sub-service (extracted to keep
  // this file under the god-module ceiling); spread into the returned bag below.
  const dependencyService = createIssueDependencyService({ database, boardEvents });

  async function createIssue(input: CreateIssueInput): Promise<CreateIssueResult> {
    const externalKey = normalizeExternalKey(input.externalKey);
    const externalUrl = validateExternalUrl(input.externalUrl);

    let createdId: string | null = null;
    for (let attempt = 1; attempt <= ISSUE_NUMBER_INSERT_ATTEMPTS; attempt++) {
      const now = new Date().toISOString();
      const id = randomUUID();

      let issueNumber: number;
      let statusId: string;
      try {
        ({ issueNumber, statusId } = await resolveNewIssueDefaults(input.projectId, input.statusId, database));
      } catch (err: unknown) {
        const e = err as { statusCode?: unknown; message?: unknown };
        if (e.statusCode === 400) throw new IssueError(String(e.message), "BAD_REQUEST");
        throw err;
      }

      const workflowDefaults = input.workflowTemplateId
        ? await resolveInitialWorkflowState(input.projectId, input.workflowTemplateId, statusId)
        : { currentNodeId: null, statusId };

      try {
        await insertIssue({
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
        }, database);
        createdId = id;
      } catch (err: unknown) {
        if (attempt < ISSUE_NUMBER_INSERT_ATTEMPTS && isIssueNumberUniqueConstraintError(err)) {
          continue;
        }
        throw err;
      }

      break;
    }

    if (!createdId) {
      throw new IssueError("Could not allocate a unique issue number", "CONFLICT");
    }

    // Align currentNodeId with the status the issue was actually created in.
    // No-op without a workflow template; for one, it sets currentNodeId to the
    // node mapping to that status (null for statuses with no node, e.g. "Todo").
    if (input.workflowTemplateId) {
      await syncCurrentNodeToStatus(database, createdId).catch(() => {});
    }

    if (input.projectId) boardEvents?.broadcast(input.projectId, "issue_created");

    return (await getIssueDescription(createdId, database));
  }

  async function resolveInitialWorkflowState(
    projectId: string,
    templateId: string,
    requestedStatusId: string,
  ): Promise<{ currentNodeId: string | null; statusId: string }> {
    const template = await getWorkflowTemplateForProject(templateId, database);
    if (!template || (template.projectId !== null && template.projectId !== projectId)) {
      throw new IssueError("Workflow template not found for project", "BAD_REQUEST");
    }

    // Honor the status the issue is created in (e.g. the column whose "+" the user
    // clicked). currentNodeId is aligned to that status by syncCurrentNodeToStatus
    // after the insert. Previously this forced every new issue onto the workflow's
    // start node — whose status is usually "In Progress" — overriding the chosen
    // column, so creating an issue in "Todo" silently landed it in "In Progress".
    return { currentNodeId: null, statusId: requestedStatusId };
  }

  async function createIssuesBatch(
    projectId: string,
    inputs: Omit<CreateIssueInput, "projectId">[],
    opts?: {
      /** When set, each created issue gets a child_of edge pointing at this parent. */
      parentIssueId?: string;
      /** When set (requires parentIssueId), a Drive record is created with metaIssueId=parentIssueId. */
      driveTarget?: string;
      /**
       * Dependency edges between the issues being created, referenced by their 0-based
       * index in `inputs` (the IDs are generated inside this call). Committed in the SAME
       * transaction as the issues so the monitor can never observe a ticket before its
       * edge exists. This is how a generating agent (butler / REST authoring path) DECLARES
       * coupling at creation — e.g. `type: "coupled_with"` between two vertical slices (#918).
       */
      dependencies?: BatchDependencyInput[];
    },
  ): Promise<{ issues: CreateIssueResult[]; driveId?: string; dependenciesCreated?: number }> {
    if (inputs.length === 0) return { issues: [] };

    for (let i = 0; i < inputs.length; i++) {
      if (!inputs[i].title || !inputs[i].title.trim()) {
        const err = new IssueError(`issues[${i}].title is required`, "BAD_REQUEST") as IssueError & { index?: number };
        err.index = i;
        throw err;
      }
    }

    const edges = validateBatchDependencies(opts?.dependencies ?? [], inputs.length);

    let results: string[] | null = null;
    for (let attempt = 1; attempt <= ISSUE_NUMBER_INSERT_ATTEMPTS; attempt++) {
      try {
        results = await withTransaction(database, async (tx) => {
          let nextNumber = await nextIssueNumber(projectId, tx);

          const defaultStatusId = await getFirstProjectStatusId(projectId, tx);
          if (defaultStatusId === null) {
            const err = new IssueError("No statuses found for project", "BAD_REQUEST");
            throw err;
          }

          const now = new Date().toISOString();
          const insertedIds: string[] = [];
          for (const input of inputs) {
            const id = randomUUID();
            const issueNumber = nextNumber++;
            await insertBatchIssue({
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
            }, tx);
            if (opts?.parentIssueId) {
              await insertDependency({
                id: randomUUID(),
                issueId: id,
                dependsOnId: opts.parentIssueId,
                type: "child_of",
                createdAt: now,
              }, tx);
            }
            insertedIds.push(id);
          }
          // Seed the declared dependency edges in the SAME transaction as the issues, so
          // autodrive never sees a coupled/blocked ticket before its edge exists (#765/#918).
          for (const e of edges) {
            await insertDependency({
              id: randomUUID(),
              issueId: insertedIds[e.issueIndex],
              dependsOnId: insertedIds[e.dependsOnIndex],
              type: e.type,
              createdAt: now,
            }, tx);
          }
          return insertedIds;
        });
        break;
      } catch (err: unknown) {
        if (attempt < ISSUE_NUMBER_INSERT_ATTEMPTS && isIssueNumberUniqueConstraintError(err)) {
          continue;
        }
        throw err;
      }
    }

    if (!results) {
      throw new IssueError("Could not allocate unique issue numbers", "CONFLICT");
    }

    const out: CreateIssueResult[] = [];
    for (const id of results) {
      out.push((await getIssueDescription(id, database)));
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

    return { issues: out, driveId, dependenciesCreated: edges.length };
  }

  async function updateIssue(
    id: string,
    body: Record<string, unknown>,
  ): Promise<CreateIssueResult> {
    const projectId = await getIssueProjectId(id, database);
    if (!projectId) throw new IssueError("Issue not found", "NOT_FOUND");

    const now = new Date().toISOString();

    const updates = buildSharedIssueUpdate(body, now);
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
    let newStatusName: string | null = null;
    if (body.statusId !== undefined) {
      const before = await getIssueWebhookSnapshot(id, database);
      if (before) {
        issueNumberForWebhook = before.issueNumber;
        issueTitleForWebhook = before.title;
        wasTerminal = isTerminalStatusView({
          statusName: before.statusName,
          currentNodeId: before.currentNodeId,
        });
      }
      newStatusName = await getProjectStatusName(body.statusId as string, database);

      // AK-535 guard: block a non-terminal -> terminal move (Done/Cancelled) while
      // the issue still has an open, non-direct, unmerged workspace — that strands
      // the branch (silent merge loss). Mirrors MCP move_issue / update_issue via
      // the shared findOpenUnmergedWorkspace seam. Runs BEFORE the status write so a
      // blocked move is a no-op (no DB change, no workspace auto-close).
      if (!wasTerminal && isTerminalStatusName(newStatusName)) {
        const openWs = await findOpenUnmergedWorkspace(id, database);
        if (openWs) {
          // newStatusName is non-null here: isTerminalStatusName returns false for null.
          throw new IssueError(openWorkspaceBlockMessage(newStatusName!, openWs.branch), "CONFLICT");
        }
      }
    }

    await updateIssueById(id, updates, database);

    // If a manual status change moved an issue that runs a workflow, keep its
    // currentNode consistent with the new board status (#78 status-as-view).
    if (body.statusId !== undefined) {
      await syncCurrentNodeToStatus(database, id).catch(() => {});
    }

    // newStatusName was resolved above (before the AK-535 guard) and is reused for
    // the terminal-transition close logic and the webhook payload.

    // When an issue transitions INTO a terminal status (Done/Cancelled/Archived),
    // close any still-open workspace for it. Otherwise the in-process monitor keeps
    // trying to relaunch the now-pointless idle workspace every cycle (#776). Only
    // act on the non-terminal -> terminal edge so re-saving an already-Done issue is
    // a no-op. We use a direct DB status update (mirroring close_workspace / merge's
    // terminal "closed" state) rather than importing the workspace service, to avoid
    // an import cycle; downstream worktree cleanup is handled on the next reconcile.
    if (body.statusId !== undefined && !wasTerminal) {
      const afterRow = await getIssueCurrentNodeInfo(id, database);
      const nowTerminal = isTerminalStatusView({
        statusName: newStatusName,
        currentNodeId: afterRow?.currentNodeId ?? null,
        currentNodeType: afterRow?.currentNodeType ?? null,
      });
      if (nowTerminal) {
        const closedAt = new Date().toISOString();
        await closeOpenWorkspacesForIssue(id, closedAt, database);
      }
    }

    if (body.statusId !== undefined && sendWebhook) {
      sendWebhook(projectId, buildIssueStatusPayload({
        issueId: id,
        issueNumber: issueNumberForWebhook,
        title: issueTitleForWebhook,
        projectId,
        newStatusId: body.statusId as string,
        newStatusName,
        statusChangedAt: now,
      }));
    }

    boardEvents?.broadcast(projectId, "issue_updated");

    return (await getIssueDescription(id, database));
  }

  async function updateIssuesBulk(
    ids: string[],
    body: Record<string, unknown>,
  ): Promise<{ updated: number; projectId: string }> {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new IssueError("issueIds must be a non-empty array", "BAD_REQUEST");
    }

    const rows = await getIssueIdsAndProjects(ids, database);

    if (rows.length !== new Set(ids).size) {
      throw new IssueError("One or more issues were not found", "NOT_FOUND");
    }

    const projectIds = new Set(rows.map((row) => row.projectId));
    if (projectIds.size !== 1) {
      throw new IssueError("Cannot bulk-update issues across projects", "BAD_REQUEST");
    }

    const now = new Date().toISOString();
    const updates = buildSharedIssueUpdate(body, now);

    const uniqueIds = [...new Set(ids)];

    // AK-535 guard (bulk): if this batch moves issues INTO a terminal status, block
    // the WHOLE batch when any issue still has an open, non-direct, unmerged
    // workspace — atomic, so no branch is silently stranded. Same guard seam as the
    // single-issue path (updateIssue), MCP and the CLI.
    if (body.statusId !== undefined) {
      const bulkStatusName = await getProjectStatusName(body.statusId as string, database);
      if (isTerminalStatusName(bulkStatusName)) {
        const blockedBranches: string[] = [];
        for (const issueId of uniqueIds) {
          const openWs = await findOpenUnmergedWorkspace(issueId, database);
          if (openWs) blockedBranches.push(openWs.branch);
        }
        if (blockedBranches.length > 0) {
          const one = blockedBranches.length === 1;
          throw new IssueError(
            `Cannot move ${blockedBranches.length} issue(s) to "${bulkStatusName}": ${one ? "it has" : "they have"} an open, unmerged workspace (branch: ${blockedBranches.join(", ")}). Merge or close ${one ? "it" : "them"} first.`,
            "CONFLICT",
          );
        }
      }
    }

    await updateIssuesByIds(uniqueIds, updates, database);

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

    // Single transaction-wrapped cascade shared with the CLI/MCP path
    // (deleteIssueCascade in @agentic-kanban/shared/lib/cascade-delete). It deletes
    // every workspace and every table that directly references the issue —
    // including issue_time_entries — atomically, so a mid-cascade error can no
    // longer leave partially deleted issue state, and the HTTP and CLI paths can no
    // longer drift. See arch-review #879.
    await deleteIssueCascade(id, database);

    boardEvents?.broadcast(projectId, "issue_deleted");
    return projectId;
  }

  async function contractCoupledIssues(
    issueIds: string[],
    leadIssueId?: string,
  ): Promise<{
    leadIssueId: string;
    memberIssueIds: string[];
    mutations: ReturnType<typeof planContraction>;
    added: number;
    removed: number;
    skipped: { edge: ReturnType<typeof planContraction>[number]; reason: string }[];
    projectIds: string[];
  }> {
    if (!Array.isArray(issueIds) || issueIds.length === 0) {
      throw new IssueError("issueIds must be a non-empty array", "BAD_REQUEST");
    }

    const uniqueIssueIds = [...new Set(issueIds)];
    const leadId = leadIssueId ?? uniqueIssueIds[0];
    if (!leadId || !uniqueIssueIds.includes(leadId)) {
      throw new IssueError("leadIssueId must be included in issueIds", "BAD_REQUEST");
    }

    const issueRows = await getIssueIdsAndProjects(uniqueIssueIds, database);
    if (issueRows.length !== uniqueIssueIds.length) {
      throw new IssueError("One or more issues were not found", "NOT_FOUND");
    }

    const projectIds = new Set(issueRows.map((row) => row.projectId));
    if (projectIds.size !== 1) {
      throw new IssueError("Cannot contract issues across projects", "BAD_REQUEST");
    }

    const projectId = issueRows[0].projectId;
    const depRows = await getDependencyRowsForProjects([projectId], database);
    const edges = depRows.map((row) => ({
      from: row.issueId,
      to: row.dependsOnId,
      type: row.type,
    }));
    const component = resolveCoupledComponent(leadId, edges);
    if (component.size < 2) {
      throw new IssueError("Selected issues are not a coupled component", "BAD_REQUEST");
    }

    const selected = new Set(uniqueIssueIds);
    const missing = [...component].filter((id) => !selected.has(id));
    const extra = uniqueIssueIds.filter((id) => !component.has(id));
    if (missing.length > 0 || extra.length > 0) {
      throw new IssueError("issueIds must exactly match the lead issue's coupled component", "BAD_REQUEST");
    }

    const memberRows = await getIssuesForContract([...component], database);
    if (memberRows.length !== component.size) {
      throw new IssueError("One or more issues were not found", "NOT_FOUND");
    }

    const openWorkspaceCount = await countOpenWorkspacesForIssues([...component], database);
    if (openWorkspaceCount > 0) {
      throw new IssueError("Cannot contract a component with open workspaces", "BAD_REQUEST");
    }

    const leadIssue = memberRows.find((row) => row.id === leadId);
    if (!leadIssue) {
      throw new IssueError("leadIssueId must be included in issueIds", "BAD_REQUEST");
    }
    const absorbedIssueIds = memberRows
      .filter((row) => row.id !== leadId)
      .sort((a, b) => a.issueNumber - b.issueNumber)
      .map((row) => row.id);

    const terminalStatusId =
      (await getStatusIdByName(projectId, "Cancelled", database)) ??
      (await getStatusIdByName(projectId, "Done", database));
    if (!terminalStatusId) {
      throw new IssueError("Project must have a Cancelled or Done status to absorb issues", "BAD_REQUEST");
    }

    const mutations = [
      ...planContraction(leadId, component, edges),
      ...absorbedIssueIds.map((id) => ({
        issueId: id,
        dependsOnId: leadId,
        type: "duplicates",
        action: "add" as const,
      })),
    ];
    const result = await dependencyService.updateDependenciesBatch(mutations);

    const now = new Date().toISOString();
    await updateIssueTitleDescription(
      leadId,
      leadIssue.title,
      buildCombinedDescription(leadId, memberRows),
      now,
      database,
    );
    for (const id of absorbedIssueIds) {
      await appendIssueDescription(id, contractPointer(leadIssue.issueNumber), now, database);
      await setIssueStatus(id, terminalStatusId, now, database);
    }
    boardEvents?.broadcast(projectId, "issue_updated");

    return {
      leadIssueId: leadId,
      memberIssueIds: [...component],
      mutations,
      added: result.added,
      removed: result.removed,
      skipped: result.skipped as { edge: ReturnType<typeof planContraction>[number]; reason: string }[],
      projectIds: result.projectIds,
    };
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
    await insertIssueArtifact({
      id,
      issueId,
      workspaceId: body.workspaceId ?? null,
      type: body.type,
      mimeType: body.mimeType ?? null,
      content: body.content,
      caption: body.caption ?? null,
    }, database);

    const projectId = await getIssueProjectId(issueId, database);
    if (projectId) boardEvents?.broadcast(projectId, "issue_updated");

    return { id, projectId };
  }

  async function getEnrichedWorkspaces(issueId: string) {
    const wsRows = await getIssueWorkspaces(issueId, database);
    const wsIds = wsRows.map(w => w.id);
    const { contextTokensMap, lastToolMap } = await enrichWorkspacesWithSessionData(wsIds, database);

    // Fetch latest session per workspace for lastSessionAt / sessionStatus
    const sessionRows = await getLatestSessionsForWorkspaces(wsIds, database);
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

  async function getArtifacts(issueId: string) {
    return getIssueArtifacts(issueId, database);
  }

  async function deleteArtifact(issueId: string, artifactId: string) {
    return deleteArtifactRepo(issueId, artifactId, database);
  }

  async function duplicateIssue(sourceId: string): Promise<CreateIssueResult> {
    const source = await getDuplicateSourceIssue(sourceId, database);

    if (!source) throw new IssueError("Issue not found", "NOT_FOUND");

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

    const archivedStatusId = await getArchivedStatusId(projectId, database);

    if (archivedStatusId === null) {
      throw new IssueError("Archived status not found for this project", "NOT_FOUND");
    }

    const doneStatusIds = await getDoneStatusIds(projectId, database);

    if (doneStatusIds.length === 0) {
      return { archived: 0 };
    }

    const cutoff = new Date(
      new Date(nowOverride ?? new Date().toISOString()).getTime() - olderThanDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const candidates = await getDoneCandidateIssues(projectId, doneStatusIds, database);

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
    await archiveIssuesByIds(toArchive, archivedStatusId, now, database);

    boardEvents?.broadcast(projectId, "issue_updated");

    return { archived: toArchive.length };
  }

  return {
    createIssue,
    createIssuesBatch,
    contractCoupledIssues,
    updateIssue,
    updateIssuesBulk,
    deleteIssue,
    addArtifact,
    deleteArtifact,
    archiveDoneIssues,
    getEnrichedWorkspaces,
    listIssues,
    getIssueSummary,
    getTags,
    assignTag,
    removeTag,
    getArtifacts,
    duplicateIssue,
    // Dependency methods: addDependency, removeDependency, updateDependenciesBatch, getDependencies.
    ...dependencyService,
  };
}
