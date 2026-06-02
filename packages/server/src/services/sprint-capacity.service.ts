import { issues, preferences, projectStatuses, workspaces } from "@agentic-kanban/shared/schema";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { deriveMonitorTunables, parseStrategyBullseyeConfig, type MonitorTunables } from "./strategy-objective.service.js";

export interface SprintCapacityPolicy {
  activeAgentsTarget: number;
  currentActive: number;
  availableSlots: number;
  maxNewStartsPerCycle: number;
  backlogFloor: number;
  currentBacklogSize: number;
  willStartCount: number;
}

export interface SprintEligibleIssue {
  id: string;
  issueNumber: number | null;
  title: string;
  priority: string | null;
  statusName: string;
  blockers: string[];
  canStart: boolean;
}

export interface SprintCapacityPlan {
  policy: SprintCapacityPolicy;
  nextEligibleIssues: SprintEligibleIssue[];
}

async function loadMonitorTunables(database: Database, projectId: string): Promise<MonitorTunables> {
  const strategyKey = `board_strategy_${projectId}`;
  const rows = await database
    .select({ value: preferences.value })
    .from(preferences)
    .where(eq(preferences.key, strategyKey))
    .limit(1);

  if (rows[0]?.value) {
    try {
      const config = parseStrategyBullseyeConfig(rows[0].value);
      return deriveMonitorTunables(config);
    } catch {
      // fall through to defaults
    }
  }

  return deriveMonitorTunables({});
}

async function countActiveWorkspaces(database: Database, projectId: string): Promise<number> {
  const ACTIVE_STATUSES = ["active", "reviewing", "fixing", "awaiting-plan-approval"] as const;

  const rows = await database
    .select({ count: sql<number>`count(distinct ${issues.id})` })
    .from(issues)
    .innerJoin(workspaces, eq(workspaces.issueId, issues.id))
    .where(and(
      eq(issues.projectId, projectId),
      inArray(workspaces.status, ACTIVE_STATUSES as unknown as string[]),
    ));

  return Number(rows[0]?.count ?? 0);
}

const BACKLOG_STATUS_NAMES = new Set(["Backlog", "Todo"]);

async function fetchEligibleIssues(
  database: Database,
  projectId: string,
): Promise<SprintEligibleIssue[]> {
  // Get all open statuses
  const allStatuses = await database
    .select({ id: projectStatuses.id, name: projectStatuses.name })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId));

  const backlogStatusIds = allStatuses
    .filter((s) => BACKLOG_STATUS_NAMES.has(s.name))
    .map((s) => s.id);

  if (backlogStatusIds.length === 0) return [];

  // Get all backlog issues
  const backlogIssues = await database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      priority: issues.priority,
      statusName: projectStatuses.name,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(and(
      eq(issues.projectId, projectId),
      inArray(issues.statusId, backlogStatusIds),
    ));

  if (backlogIssues.length === 0) return [];

  const issueIds = backlogIssues.map((i) => i.id);

  // Check which issues already have an open workspace
  const openWorkspaceRows = await database
    .select({ issueId: workspaces.issueId })
    .from(workspaces)
    .where(and(
      inArray(workspaces.issueId, issueIds),
      ne(workspaces.status, "closed"),
    ));
  const issueIdsWithOpenWorkspace = new Set(openWorkspaceRows.map((r) => r.issueId));

  return backlogIssues.map((issue) => {
    const hasWorkspace = issueIdsWithOpenWorkspace.has(issue.id);
    const blockers: string[] = [];
    if (hasWorkspace) {
      blockers.push("Already has an open workspace");
    }
    return {
      id: issue.id,
      issueNumber: issue.issueNumber,
      title: issue.title,
      priority: issue.priority,
      statusName: issue.statusName,
      blockers,
      canStart: !hasWorkspace,
    };
  });
}

export async function buildSprintCapacityPlan(
  database: Database,
  projectId: string,
): Promise<SprintCapacityPlan> {
  const [tunables, currentActive, eligibleIssues] = await Promise.all([
    loadMonitorTunables(database, projectId),
    countActiveWorkspaces(database, projectId),
    fetchEligibleIssues(database, projectId),
  ]);

  const availableSlots = Math.max(0, tunables.activeAgentsTarget - currentActive);
  const startableCandidates = eligibleIssues.filter((i) => i.canStart);
  const willStartCount = Math.min(availableSlots, tunables.maxNewStartsPerCycle, startableCandidates.length);
  const currentBacklogSize = eligibleIssues.filter((i) => i.canStart).length;

  return {
    policy: {
      activeAgentsTarget: tunables.activeAgentsTarget,
      currentActive,
      availableSlots,
      maxNewStartsPerCycle: tunables.maxNewStartsPerCycle,
      backlogFloor: tunables.backlogFloor,
      currentBacklogSize,
      willStartCount,
    },
    nextEligibleIssues: eligibleIssues,
  };
}
