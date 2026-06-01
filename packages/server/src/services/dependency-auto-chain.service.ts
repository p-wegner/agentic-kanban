import { randomUUID } from "node:crypto";
import { issueComments, issueDependencies, issues, issueTags, projectStatuses, tags, workflowNodes, workspaces } from "@agentic-kanban/shared/schema";
import { isResolvedDependencyStatusView } from "@agentic-kanban/shared";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "./board-events.js";
import type { SessionManager } from "./session.manager.js";
import type { GitService } from "./workspace-internals.js";
import { createWorkspaceCrudService } from "./workspace-crud.service.js";

const BLOCKING_DEPENDENCY_TYPES = ["depends_on", "blocked_by"] as const;
const AUTO_CHAIN_TRIGGER_TYPES = ["depends_on", "blocked_by", "child_of"] as const;
const SKIP_AUTO_START_TAG = "no-auto-start";

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
  reason: "ready" | "no-candidates" | "wip-limit" | "missing-status" | "skip-tag" | "cycle";
  currentWip: number;
  wipLimit: number;
}

type DependencyRow = {
  issueId: string;
  dependsOnId: string;
  type: string;
};

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "") || "issue";
}

function findCycleIssueIds(issueIds: string[], deps: DependencyRow[]): Set<string> {
  const scopedIds = new Set(issueIds);
  const adjacency = new Map<string, string[]>();
  for (const id of issueIds) adjacency.set(id, []);
  for (const dep of deps) {
    if (!AUTO_CHAIN_TRIGGER_TYPES.includes(dep.type as typeof AUTO_CHAIN_TRIGGER_TYPES[number])) continue;
    if (!scopedIds.has(dep.issueId) || !scopedIds.has(dep.dependsOnId)) continue;
    adjacency.get(dep.issueId)?.push(dep.dependsOnId);
  }

  const cycleIds = new Set<string>();
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];

  function visit(id: string) {
    state.set(id, "visiting");
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      if (state.get(next) === "visiting") {
        const start = stack.indexOf(next);
        for (const cycleId of stack.slice(start)) cycleIds.add(cycleId);
      } else if (!state.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    state.set(id, "visited");
  }

  for (const id of issueIds) {
    if (!state.has(id)) visit(id);
  }
  return cycleIds;
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
      inArray(issueDependencies.type, AUTO_CHAIN_TRIGGER_TYPES),
      inArray(issues.statusId, startableStatusIds),
    ))
    .orderBy(asc(projectStatuses.sortOrder), asc(issues.sortOrder), asc(issues.issueNumber));

  if (candidates.length === 0) {
    return { candidate: null, reason: "no-candidates", currentWip, wipLimit };
  }

  const projectDependencyRows = await database
    .select({
      issueId: issueDependencies.issueId,
      dependsOnId: issueDependencies.dependsOnId,
      type: issueDependencies.type,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
    .where(eq(issues.projectId, projectId));
  const cycleIssueIds = findCycleIssueIds(
    [...new Set(projectDependencyRows.flatMap((dep) => [dep.issueId, dep.dependsOnId]))],
    projectDependencyRows,
  );

  let skippedForTag = false;
  let skippedForCycle = false;

  for (const candidate of candidates) {
    if (cycleIssueIds.has(candidate.id)) {
      skippedForCycle = true;
      continue;
    }

    const skipTagRows = await database
      .select({ id: tags.id })
      .from(issueTags)
      .innerJoin(tags, eq(issueTags.tagId, tags.id))
      .where(and(eq(issueTags.issueId, candidate.id), eq(tags.name, SKIP_AUTO_START_TAG)))
      .limit(1);
    if (skipTagRows.length > 0) {
      skippedForTag = true;
      continue;
    }

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
    if (blockerIds.length === 0) {
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

  if (skippedForCycle) return { candidate: null, reason: "cycle", currentWip, wipLimit };
  if (skippedForTag) return { candidate: null, reason: "skip-tag", currentWip, wipLimit };
  return { candidate: null, reason: "no-candidates", currentWip, wipLimit };
}

async function addAutoChainAuditComment(args: {
  database: Database;
  issueId: string;
  workspaceId?: string | null;
  body: string;
  payload: Record<string, unknown>;
}) {
  await args.database.insert(issueComments).values({
    id: randomUUID(),
    issueId: args.issueId,
    workspaceId: args.workspaceId ?? null,
    kind: "note",
    author: "butler",
    body: args.body,
    payload: JSON.stringify({ trigger: "dependency-auto-chain", ...args.payload }),
    createdAt: new Date().toISOString(),
  });
}

export async function autoStartUnblockedDependencyIssue(args: {
  database: Database;
  projectId: string | null;
  completedIssueId: string;
  prefMap: Map<string, string>;
  getSessionManager?: () => SessionManager;
  boardEvents?: BoardEvents;
  gitService?: GitService;
  createWorkspace?: (candidate: AutoStartCandidate, branch: string) => Promise<{ id?: string; error?: string }>;
}): Promise<void> {
  const { database, projectId, completedIssueId, prefMap, getSessionManager, boardEvents, gitService } = args;
  if (!projectId) return;
  if (prefMap.get("dependency_auto_chain") !== "true") return;
  if (!getSessionManager && !args.createWorkspace) return;

  const parsedLimit = Number.parseInt(prefMap.get("nudge_wip_limit") || "5", 10);
  const wipLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 5;
  const decision = await findAutoStartableDependencyIssue({ database, projectId, completedIssueId, wipLimit });
  if (!decision.candidate) {
    const reasonText: Record<AutoStartDecision["reason"], string> = {
      ready: "ready",
      "no-candidates": "no dependent or child issues were newly startable",
      "wip-limit": "WIP limit is full",
      "missing-status": "required Todo/Backlog/In Progress statuses are missing",
      "skip-tag": `a dependent issue has the ${SKIP_AUTO_START_TAG} tag`,
      cycle: "a dependency cycle was detected",
    };
    await addAutoChainAuditComment({
      database,
      issueId: completedIssueId,
      body: `Dependency auto-chain did not start a follow-up: ${reasonText[decision.reason]}. WIP is ${decision.currentWip}/${decision.wipLimit}.`,
      payload: { completedIssueId, reason: decision.reason, currentWip: decision.currentWip, wipLimit: decision.wipLimit },
    });
    console.log(`[dependency-auto-chain] skipped after issue ${completedIssueId}: ${decision.reason} (${decision.currentWip}/${decision.wipLimit} WIP)`);
    return;
  }

  const candidate = decision.candidate;
  const branch = `feature/ak-${candidate.issueNumber ?? "next"}-${slugifyTitle(candidate.title)}`;
  const workspace = args.createWorkspace
    ? await args.createWorkspace(candidate, branch)
    : await createWorkspaceCrudService({ database, getSessionManager, boardEvents, gitService }).createWorkspace({ issueId: candidate.id, branch });
  if (workspace.error) {
    await addAutoChainAuditComment({
      database,
      issueId: candidate.id,
      body: `Dependency auto-chain tried to start this issue after an upstream merge, but workspace creation failed: ${workspace.error}`,
      payload: { completedIssueId, reason: "workspace-create-failed", error: workspace.error },
    });
    console.warn(`[dependency-auto-chain] workspace creation failed for issue #${candidate.issueNumber ?? "?"}: ${workspace.error}`);
    return;
  }
  const workspaceId = workspace.id;
  const completedLabel = completedIssueId.slice(0, 8);
  const body = `Auto-started after dependency ${completedLabel} was resolved by merge. All blocking \`depends_on\` / \`blocked_by\` dependencies are resolved, and WIP is ${candidate.currentWip}/${candidate.wipLimit}.`;

  await addAutoChainAuditComment({
    database,
    issueId: candidate.id,
    workspaceId,
    body,
    payload: { completedIssueId, workspaceId, reason: "started", currentWip: candidate.currentWip, wipLimit: candidate.wipLimit },
  });
  console.log(`[dependency-auto-chain] Auto-started issue #${candidate.issueNumber ?? "?"} (${candidate.id}) after dependency ${completedIssueId} resolved; workspace=${workspaceId}`);
  boardEvents?.broadcast(projectId, "issue_updated");
}
