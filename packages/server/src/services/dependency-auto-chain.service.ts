import { randomUUID } from "node:crypto";
import { issueComments, issueDependencies, issues, projectStatuses, workflowNodes, workspaces } from "@agentic-kanban/shared/schema";
import { isResolvedDependencyStatusView } from "@agentic-kanban/shared";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "./board-events.js";
import type { SessionManager } from "./session.manager.js";
import type { GitService } from "./workspace-internals.js";
import { createWorkspaceCrudService } from "./workspace-crud.service.js";

const BLOCKING_DEPENDENCY_TYPES = ["depends_on", "blocked_by"] as const;

export interface AutoStartCandidate {
  id: string;
  title: string;
  issueNumber: number | null;
  projectId: string;
  currentWip: number;
  wipLimit: number;
}

export interface AutoStartDecision {
  candidate: AutoStartCandidate | null;
  reason: "ready" | "no-candidates" | "wip-limit" | "missing-status";
  currentWip: number;
  wipLimit: number;
}

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "") || "issue";
}

export async function findAutoStartableDependencyIssue(args: {
  database: Database;
  projectId: string;
  completedIssueId: string;
  wipLimit: number;
}): Promise<AutoStartDecision> {
  const { database, projectId, completedIssueId, wipLimit } = args;

  const statuses = await database
    .select({ id: projectStatuses.id, name: projectStatuses.name, sortOrder: projectStatuses.sortOrder })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId));

  const inProgressStatusIds = statuses.filter((s) => s.name === "In Progress").map((s) => s.id);
  const startableStatusIds = statuses.filter((s) => s.name === "Todo" || s.name === "Backlog").map((s) => s.id);
  if (inProgressStatusIds.length === 0 || startableStatusIds.length === 0) {
    return { candidate: null, reason: "missing-status", currentWip: 0, wipLimit };
  }

  const activeWipRows = await database
    .select({ count: sql<number>`count(distinct ${issues.id})` })
    .from(issues)
    .innerJoin(workspaces, eq(workspaces.issueId, issues.id))
    .where(and(
      eq(issues.projectId, projectId),
      inArray(issues.statusId, inProgressStatusIds),
      ne(workspaces.status, "closed"),
    ));
  const currentWip = Number(activeWipRows[0]?.count ?? 0);
  if (currentWip >= wipLimit) {
    return { candidate: null, reason: "wip-limit", currentWip, wipLimit };
  }

  const candidates = await database
    .select({
      id: issues.id,
      title: issues.title,
      issueNumber: issues.issueNumber,
      projectId: issues.projectId,
      statusSortOrder: projectStatuses.sortOrder,
      sortOrder: issues.sortOrder,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(and(
      eq(issues.projectId, projectId),
      eq(issueDependencies.dependsOnId, completedIssueId),
      inArray(issueDependencies.type, BLOCKING_DEPENDENCY_TYPES),
      inArray(issues.statusId, startableStatusIds),
    ))
    .orderBy(asc(projectStatuses.sortOrder), asc(issues.sortOrder), asc(issues.issueNumber));

  for (const candidate of candidates) {
    const existingOpenWorkspace = await database
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.issueId, candidate.id), ne(workspaces.status, "closed")))
      .limit(1);
    if (existingOpenWorkspace.length > 0) continue;

    const blockingDeps = await database
      .select({ dependsOnId: issueDependencies.dependsOnId })
      .from(issueDependencies)
      .where(and(
        eq(issueDependencies.issueId, candidate.id),
        inArray(issueDependencies.type, BLOCKING_DEPENDENCY_TYPES),
      ));
    const blockerIds = [...new Set(blockingDeps.map((dep) => dep.dependsOnId))];
    if (blockerIds.length === 0) continue;

    const blockers = await database
      .select({
        id: issues.id,
        statusName: projectStatuses.name,
        currentNodeId: issues.currentNodeId,
        currentNodeType: workflowNodes.nodeType,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
      .where(inArray(issues.id, blockerIds));

    if (blockers.length !== blockerIds.length) continue;
    if (!blockers.every((blocker) => isResolvedDependencyStatusView(blocker))) continue;

    return {
      candidate: {
        id: candidate.id,
        title: candidate.title,
        issueNumber: candidate.issueNumber,
        projectId: candidate.projectId,
        currentWip,
        wipLimit,
      },
      reason: "ready",
      currentWip,
      wipLimit,
    };
  }

  return { candidate: null, reason: "no-candidates", currentWip, wipLimit };
}

export async function autoStartUnblockedDependencyIssue(args: {
  database: Database;
  projectId: string | null;
  completedIssueId: string;
  prefMap: Map<string, string>;
  getSessionManager?: () => SessionManager;
  boardEvents?: BoardEvents;
  gitService?: GitService;
}): Promise<void> {
  const { database, projectId, completedIssueId, prefMap, getSessionManager, boardEvents, gitService } = args;
  if (!projectId) return;
  if (prefMap.get("auto_monitor") !== "true" || prefMap.get("nudge_auto_start") !== "true") return;
  if (!getSessionManager) return;

  const parsedLimit = Number.parseInt(prefMap.get("nudge_wip_limit") || "5", 10);
  const wipLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 5;
  const decision = await findAutoStartableDependencyIssue({ database, projectId, completedIssueId, wipLimit });
  if (!decision.candidate) {
    console.log(`[dependency-auto-chain] skipped after issue ${completedIssueId}: ${decision.reason} (${decision.currentWip}/${decision.wipLimit} WIP)`);
    return;
  }

  const candidate = decision.candidate;
  const branch = `feature/ak-${candidate.issueNumber ?? "next"}-${slugifyTitle(candidate.title)}`;
  const workspaceService = createWorkspaceCrudService({ database, getSessionManager, boardEvents, gitService });
  const workspace = await workspaceService.createWorkspace({ issueId: candidate.id, branch });
  if (workspace.error) {
    console.warn(`[dependency-auto-chain] workspace creation failed for issue #${candidate.issueNumber ?? "?"}: ${workspace.error}`);
    return;
  }
  const workspaceId = workspace.id;
  const completedLabel = completedIssueId.slice(0, 8);
  const body = `Auto-started after dependency ${completedLabel} was resolved by merge. All blocking \`depends_on\` / \`blocked_by\` dependencies are resolved, and WIP is ${candidate.currentWip}/${candidate.wipLimit}.`;

  await database.insert(issueComments).values({
    id: randomUUID(),
    issueId: candidate.id,
    workspaceId,
    kind: "note",
    author: "butler",
    body,
    payload: JSON.stringify({ trigger: "dependency-auto-chain", completedIssueId, workspaceId }),
    createdAt: new Date().toISOString(),
  });
  console.log(`[dependency-auto-chain] Auto-started issue #${candidate.issueNumber ?? "?"} (${candidate.id}) after dependency ${completedIssueId} resolved; workspace=${workspaceId}`);
  boardEvents?.broadcast(projectId, "issue_updated");
}
