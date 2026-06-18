import { isResolvedDependencyStatusView } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "./board-events.js";
import type { SessionManager } from "./session.manager.js";
import type { GitService } from "./workspace-internals.js";
import { createWorkspaceCrudService } from "./workspace-crud.service.js";
import { resolveStartPolicy } from "./start-policy.service.js";
import {
  getProjectStatusesForAutoChain,
  getActiveWipCount,
  getAutoChainCandidates,
  getProjectDependencyRows,
  hasSkipAutoStartTag,
  hasExistingOpenWorkspace,
  getBlockingDependencyIds,
  getBlockerStatuses,
  insertAutoChainAuditComment,
} from "../repositories/dependency-auto-chain.repository.js";

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

  const statuses = await getProjectStatusesForAutoChain(projectId, database);

  const inProgressStatusIds = statuses.filter((s) => s.name === "In Progress").map((s) => s.id);
  const startableStatusIds = statuses.filter((s) => s.name === "Todo" || s.name === "Backlog").map((s) => s.id);
  if (inProgressStatusIds.length === 0 || startableStatusIds.length === 0) {
    return { candidate: null, reason: "missing-status", currentWip: 0, wipLimit };
  }

  const currentWip = await getActiveWipCount(projectId, inProgressStatusIds, database);
  if (currentWip >= wipLimit) {
    return { candidate: null, reason: "wip-limit", currentWip, wipLimit };
  }

  const candidates = await getAutoChainCandidates({
    projectId,
    completedIssueId,
    triggerTypes: AUTO_CHAIN_TRIGGER_TYPES,
    startableStatusIds,
  }, database);

  if (candidates.length === 0) {
    return { candidate: null, reason: "no-candidates", currentWip, wipLimit };
  }

  const projectDependencyRows = await getProjectDependencyRows(projectId, database);
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

    if (await hasSkipAutoStartTag(candidate.id, SKIP_AUTO_START_TAG, database)) {
      skippedForTag = true;
      continue;
    }

    if (await hasExistingOpenWorkspace(candidate.id, database)) continue;

    const blockerIds = await getBlockingDependencyIds(candidate.id, BLOCKING_DEPENDENCY_TYPES, database);
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

    const blockers = await getBlockerStatuses(blockerIds, database);

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
  await insertAutoChainAuditComment({
    issueId: args.issueId,
    workspaceId: args.workspaceId,
    body: args.body,
    payload: args.payload,
  }, args.database);
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
  // The post-merge cascade is gated by the project's Start Mode (the single source of truth),
  // NOT by `dependency_auto_chain` alone. `manual` (and `conductor`) mode stop it — this closes
  // the leak where the cascade kept auto-starting tickets with every "drive" switch off.
  const policy = resolveStartPolicy(prefMap, projectId);
  if (!policy.postMergeCascade) return;
  if (!getSessionManager && !args.createWorkspace) return;

  const wipLimit = policy.wip.activeAgentsTarget;
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
  let workspace: { id?: string; error?: string };
  try {
    workspace = args.createWorkspace
      ? await args.createWorkspace(candidate, branch)
      : await createWorkspaceCrudService({ database, getSessionManager, boardEvents, gitService }).createWorkspace({ issueId: candidate.id, branch });
  } catch (err) {
    workspace = { error: err instanceof Error ? err.message : String(err) };
  }
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
