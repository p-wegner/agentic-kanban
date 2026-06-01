import { issueDependencies, issues, preferences, projectStatuses, workflowNodes, workspaces } from "@agentic-kanban/shared/schema";
import { isResolvedDependencyStatusView, isTerminalStatusView, type DependencyWavePlan, type DependencyWaveStartResult } from "@agentic-kanban/shared";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "./board-events.js";
import type { SessionManager } from "./session.manager.js";
import type { GitService } from "./workspace-internals.js";
import { createWorkspaceCrudService } from "./workspace-crud.service.js";

const BLOCKING_DEPENDENCY_TYPES = ["depends_on", "blocked_by"] as const;
const STARTABLE_STATUS_NAMES = new Set(["Backlog", "Todo"]);

type BlockingDependencyType = typeof BLOCKING_DEPENDENCY_TYPES[number];

type IssueRow = {
  id: string;
  issueNumber: number | null;
  title: string;
  statusName: string;
  statusId: string;
  sortOrder: number;
  currentNodeId: string | null;
  currentNodeType: string | null;
};

type DependencyRow = {
  id: string;
  issueId: string;
  dependsOnId: string;
  type: string;
};

export interface DependencyWaveStartDeps {
  getSessionManager?: () => SessionManager;
  boardEvents?: BoardEvents;
  gitService?: GitService;
  createWorkspace?: (issue: { id: string; issueNumber: number | null; title: string }) => Promise<{ id?: string; error?: string }>;
}

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "") || "issue";
}

function toPlanIssue(issue: IssueRow, extras: {
  startEligible: boolean;
  blockers?: Array<{ issueId: string; issueNumber: number | null; title: string; statusName: string }>;
  reasons?: string[];
}) {
  return {
    id: issue.id,
    issueNumber: issue.issueNumber,
    title: issue.title,
    statusName: issue.statusName,
    startEligible: extras.startEligible,
    blockers: extras.blockers ?? [],
    reasons: extras.reasons ?? [],
  };
}

function findCycleIssueIds(issueIds: string[], deps: DependencyRow[]): Set<string> {
  const openIds = new Set(issueIds);
  const adjacency = new Map<string, string[]>();
  for (const id of issueIds) adjacency.set(id, []);
  for (const dep of deps) {
    if (!isBlockingType(dep.type) || !openIds.has(dep.issueId) || !openIds.has(dep.dependsOnId)) continue;
    adjacency.get(dep.issueId)?.push(dep.dependsOnId);
  }

  const cycleIds = new Set<string>();
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];

  function dfs(id: string) {
    state.set(id, "visiting");
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      if (state.get(next) === "visiting") {
        const start = stack.indexOf(next);
        for (const cycleId of stack.slice(start)) cycleIds.add(cycleId);
      } else if (!state.has(next)) {
        dfs(next);
      }
    }
    stack.pop();
    state.set(id, "visited");
  }

  for (const id of issueIds) {
    if (!state.has(id)) dfs(id);
  }
  return cycleIds;
}

function isBlockingType(type: string): type is BlockingDependencyType {
  return (BLOCKING_DEPENDENCY_TYPES as readonly string[]).includes(type);
}

async function getWipInfo(database: Database, projectId: string, wipLimitOverride?: number) {
  const prefRows = await database.select({ value: preferences.value }).from(preferences).where(eq(preferences.key, "nudge_wip_limit")).limit(1);
  const parsedLimit = wipLimitOverride ?? Number.parseInt(prefRows[0]?.value ?? "5", 10);
  const wipLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 5;

  const inProgressStatuses = await database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.name, "In Progress")));
  const inProgressStatusIds = inProgressStatuses.map((status) => status.id);
  if (inProgressStatusIds.length === 0) {
    return { current: 0, limit: wipLimit, available: wipLimit };
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
  const current = Number(activeWipRows[0]?.count ?? 0);
  return { current, limit: wipLimit, available: Math.max(0, wipLimit - current) };
}

export async function buildDependencyWavePlan(
  database: Database,
  projectId: string,
  options: { wipLimit?: number } = {},
): Promise<DependencyWavePlan> {
  const projectIssues = await database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      statusName: projectStatuses.name,
      statusId: issues.statusId,
      sortOrder: issues.sortOrder,
      currentNodeId: issues.currentNodeId,
      currentNodeType: workflowNodes.nodeType,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(eq(issues.projectId, projectId))
    .orderBy(asc(projectStatuses.sortOrder), asc(issues.sortOrder), asc(issues.issueNumber));

  const allIssuesById = new Map(projectIssues.map((issue) => [issue.id, issue]));
  const openIssues = projectIssues.filter((issue) => !isTerminalStatusView(issue));
  const openIssueIds = openIssues.map((issue) => issue.id);
  const openIssuesById = new Map(openIssues.map((issue) => [issue.id, issue]));

  const openWorkspaceRows = openIssueIds.length === 0
    ? []
    : await database
      .select({ issueId: workspaces.issueId })
      .from(workspaces)
      .where(and(inArray(workspaces.issueId, openIssueIds), ne(workspaces.status, "closed")));
  const issueIdsWithOpenWorkspace = new Set(openWorkspaceRows.map((row) => row.issueId));

  const dependencyRows = projectIssues.length === 0
    ? []
    : await database
      .select({
        id: issueDependencies.id,
        issueId: issueDependencies.issueId,
        dependsOnId: issueDependencies.dependsOnId,
        type: issueDependencies.type,
      })
      .from(issueDependencies)
      .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
      .where(eq(issues.projectId, projectId));

  const depsByIssue = new Map<string, DependencyRow[]>();
  for (const dep of dependencyRows) {
    if (!isBlockingType(dep.type)) continue;
    const existing = depsByIssue.get(dep.issueId) ?? [];
    existing.push(dep);
    depsByIssue.set(dep.issueId, existing);
  }

  const cycleIssueIds = findCycleIssueIds(openIssueIds, dependencyRows);
  const readyNow: DependencyWavePlan["readyNow"] = [];
  const blocked: DependencyWavePlan["blocked"] = [];
  const cyclicInvalid: DependencyWavePlan["cyclicInvalid"] = [];

  for (const issue of openIssues) {
    const deps = depsByIssue.get(issue.id) ?? [];
    const startEligible = STARTABLE_STATUS_NAMES.has(issue.statusName) && !issueIdsWithOpenWorkspace.has(issue.id);
    const blockers: Array<{ issueId: string; issueNumber: number | null; title: string; statusName: string }> = [];
    const reasons: string[] = [];
    const invalidReasons: string[] = [];

    for (const dep of deps) {
      const upstream = allIssuesById.get(dep.dependsOnId);
      if (!upstream) {
        invalidReasons.push(`Missing upstream issue ${dep.dependsOnId}`);
        continue;
      }
      if (!isResolvedDependencyStatusView(upstream)) {
        blockers.push({
          issueId: upstream.id,
          issueNumber: upstream.issueNumber,
          title: upstream.title,
          statusName: upstream.statusName,
        });
      }
    }

    if (cycleIssueIds.has(issue.id) || invalidReasons.length > 0) {
      cyclicInvalid.push(toPlanIssue(issue, {
        startEligible: false,
        blockers,
        reasons: [
          ...(cycleIssueIds.has(issue.id) ? ["Dependency cycle detected"] : []),
          ...invalidReasons,
        ],
      }));
    } else if (blockers.length > 0) {
      const blockerLabels = blockers.map((blocker) => blocker.issueNumber != null ? `#${blocker.issueNumber}` : blocker.title);
      blocked.push(toPlanIssue(issue, {
        startEligible: false,
        blockers,
        reasons: [`Blocked by open upstream work: ${blockerLabels.join(", ")}`],
      }));
    } else {
      readyNow.push(toPlanIssue(issue, {
        startEligible,
        reasons: startEligible ? [] : [
          issueIdsWithOpenWorkspace.has(issue.id)
            ? "Already has an open workspace"
            : `Status ${issue.statusName} is not auto-startable`,
        ],
      }));
    }
  }

  const wip = await getWipInfo(database, projectId, options.wipLimit);
  return { projectId, readyNow, blocked, cyclicInvalid, wip };
}

export async function startNextDependencyWave(
  database: Database,
  projectId: string,
  deps: DependencyWaveStartDeps = {},
): Promise<DependencyWaveStartResult> {
  const plan = await buildDependencyWavePlan(database, projectId);
  const candidates = plan.readyNow.filter((issue) => issue.startEligible).slice(0, plan.wip.available);
  const started: DependencyWaveStartResult["started"] = [];
  const failed: DependencyWaveStartResult["failed"] = [];

  const workspaceService = deps.createWorkspace
    ? null
    : createWorkspaceCrudService({
      database,
      getSessionManager: deps.getSessionManager,
      boardEvents: deps.boardEvents,
      gitService: deps.gitService,
    });

  for (const issue of candidates) {
    const result = deps.createWorkspace
      ? await deps.createWorkspace(issue)
      : await workspaceService!.createWorkspace({
        issueId: issue.id,
        branch: `feature/ak-${issue.issueNumber ?? "next"}-${slugifyTitle(issue.title)}`,
      });

    if (result.error) {
      failed.push({ issueId: issue.id, issueNumber: issue.issueNumber, error: result.error });
    } else {
      started.push({ issueId: issue.id, issueNumber: issue.issueNumber, workspaceId: result.id ?? "unknown" });
    }
  }

  if (started.length > 0) deps.boardEvents?.broadcast(projectId, "board_changed");

  return {
    started,
    failed,
    skipped: {
      wipLimit: plan.wip.limit,
      currentWip: plan.wip.current,
      availableSlots: plan.wip.available,
      readyButNotStarted: Math.max(0, plan.readyNow.filter((issue) => issue.startEligible).length - candidates.length),
    },
  };
}
