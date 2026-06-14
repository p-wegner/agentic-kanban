// Drive dashboard aggregation (#800).
//
// Computes the at-a-glance view of a running drive: N/N progress, the dependency
// tier graph, current stalls, the last cascade (merge) event, and cold-build-clean
// status — all from the board + dependency graph + the board-health-event log.
//
// Scope = the drive's meta/epic issue and its DIRECT children (the `parent_of`
// edges the drive-epic seeder wires). This deliberately mirrors how a drive epic
// is structured (one epic, a flat fan-out of children) rather than walking an
// arbitrary tree. The meta issue itself is excluded from progress/tiers.
//
// No live build runs here — the cold-clone gate is a multi-minute fresh clone +
// build, far too expensive for a pollable dashboard. We report the gate's
// enablement plus the most recent build/verify-related health event instead.

import { eq, inArray } from "drizzle-orm";
import {
  issueDependencies,
  issues,
  projectStatuses,
  workflowNodes,
} from "@agentic-kanban/shared/schema";
import {
  computeBlockerReadiness,
  isResolvedDependencyStatusView,
  isTerminalStatusView,
  type DriveDashboard,
  type DriveDashboardIssue,
} from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import { getDriveById } from "../repositories/drive.repository.js";
import { listBoardHealthEvents } from "../repositories/board-health-events.repository.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { coldCloneCheckPrefKey } from "./cold-clone-build-check.service.js";
import { verifyScriptPrefKey } from "./stack-profile.service.js";
import { DriveError } from "./drive.service.js";

const BLOCKING_DEPENDENCY_TYPES = new Set(["depends_on", "blocked_by"]);

type ScopedIssue = {
  id: string;
  issueNumber: number | null;
  title: string;
  statusName: string;
  currentNodeId: string | null;
  currentNodeType: string | null;
};

/** Keywords that mark a health event as build/verify-related (case-insensitive). */
const BUILD_EVENT_RE = /(build|verify|cold-clone|cold clone|compile|typecheck|tsc)/i;

/**
 * Resolve the drive's scoped issues = the meta issue's direct `parent_of` children.
 * Returns an empty list when the drive has no meta issue (a drive can be created
 * before its epic exists).
 */
async function loadScopedIssues(
  database: Database,
  projectId: string,
  metaIssueId: string | null,
): Promise<ScopedIssue[]> {
  if (!metaIssueId) return [];

  const edges = await database
    .select({ childId: issueDependencies.dependsOnId, type: issueDependencies.type })
    .from(issueDependencies)
    .where(eq(issueDependencies.issueId, metaIssueId));
  // The drive-epic seeder wires epic→child as `parent_of`. Prefer those; fall
  // back to every outgoing edge if a drive was wired with a different type, so a
  // hand-assembled drive still surfaces its children.
  const parentOfChildIds = edges.filter((e) => e.type === "parent_of").map((e) => e.childId);
  const scopedIds = parentOfChildIds.length > 0
    ? parentOfChildIds
    : edges.map((e) => e.childId);
  if (scopedIds.length === 0) return [];

  const rows = await database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      projectId: issues.projectId,
      statusName: projectStatuses.name,
      currentNodeId: issues.currentNodeId,
      currentNodeType: workflowNodes.nodeType,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(inArray(issues.id, scopedIds));
  // Keep only same-project children with a resolved status (defensive — a drive's
  // children always belong to its project).
  return rows
    .filter((r) => r.projectId === projectId && r.statusName != null)
    .map(({ projectId: _pid, ...rest }) => rest) as ScopedIssue[];
}

/**
 * Assign a dependency tier to each scoped issue: tier 0 = no blocking dependency
 * on another scoped issue; tier N = one past the max tier of its in-scope
 * blockers. Cycles fall back to tier 0 so the graph always renders.
 */
function computeTiers(
  scoped: ScopedIssue[],
  blockingDepsByIssue: Map<string, string[]>,
): Map<string, number> {
  const scopedIds = new Set(scoped.map((i) => i.id));
  const tierById = new Map<string, number>();

  function tierOf(id: string, stack: Set<string>): number {
    if (tierById.has(id)) return tierById.get(id)!;
    if (stack.has(id)) return 0; // cycle guard
    const blockers = (blockingDepsByIssue.get(id) ?? []).filter((b) => scopedIds.has(b));
    if (blockers.length === 0) {
      tierById.set(id, 0);
      return 0;
    }
    stack.add(id);
    const maxBlockerTier = Math.max(...blockers.map((b) => tierOf(b, stack)));
    stack.delete(id);
    const tier = maxBlockerTier + 1;
    tierById.set(id, tier);
    return tier;
  }

  for (const issue of scoped) tierOf(issue.id, new Set());
  return tierById;
}

/** Build the full drive dashboard for one drive. */
export async function buildDriveDashboard(
  database: Database,
  projectId: string,
  driveId: string,
): Promise<DriveDashboard> {
  const drive = await getDriveById(driveId, database);
  if (!drive) throw new DriveError("Drive not found", "NOT_FOUND");
  if (drive.projectId !== projectId) {
    throw new DriveError("Drive does not belong to this project", "FORBIDDEN");
  }

  const scoped = await loadScopedIssues(database, projectId, drive.metaIssueId);
  const scopedById = new Map(scoped.map((i) => [i.id, i]));

  // --- dependency edges among scoped issues (for tiers + stalls) ---
  const blockingDepsByIssue = new Map<string, string[]>();
  if (scoped.length > 0) {
    const deps = await database
      .select({
        issueId: issueDependencies.issueId,
        dependsOnId: issueDependencies.dependsOnId,
        type: issueDependencies.type,
      })
      .from(issueDependencies)
      .where(inArray(issueDependencies.issueId, scoped.map((i) => i.id)));
    for (const dep of deps) {
      if (!BLOCKING_DEPENDENCY_TYPES.has(dep.type)) continue;
      const list = blockingDepsByIssue.get(dep.issueId) ?? [];
      list.push(dep.dependsOnId);
      blockingDepsByIssue.set(dep.issueId, list);
    }
  }

  // --- progress ---
  let done = 0;
  let inProgress = 0;
  let inReview = 0;
  let todo = 0;
  for (const issue of scoped) {
    if (isTerminalStatusView(issue)) {
      done++;
    } else if (issue.statusName === "In Progress") {
      inProgress++;
    } else if (issue.statusName === "In Review" || issue.statusName === "AI Reviewed") {
      inReview++;
    } else {
      todo++;
    }
  }
  const total = scoped.length;
  const percentDone = total === 0 ? 0 : Math.round((done / total) * 100);

  // --- tiers ---
  const tierById = computeTiers(scoped, blockingDepsByIssue);
  const tierGroups = new Map<number, DriveDashboardIssue[]>();
  for (const issue of scoped) {
    const tier = tierById.get(issue.id) ?? 0;
    const list = tierGroups.get(tier) ?? [];
    list.push({
      id: issue.id,
      issueNumber: issue.issueNumber,
      title: issue.title,
      statusName: issue.statusName,
      tier,
    });
    tierGroups.set(tier, list);
  }
  const tiers = [...tierGroups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tier, tierIssues]) => ({
      tier,
      issues: tierIssues.sort(
        (a, b) => (a.issueNumber ?? Infinity) - (b.issueNumber ?? Infinity),
      ),
    }));

  // --- stalls: open scoped issues blocked by an open in-scope upstream ---
  const stalls: DriveDashboard["stalls"] = [];
  for (const issue of scoped) {
    if (isTerminalStatusView(issue)) continue;
    const blockerIds = blockingDepsByIssue.get(issue.id) ?? [];
    const openBlockers = blockerIds
      .map((bid) => scopedById.get(bid))
      .filter((b): b is ScopedIssue => {
        if (!b) return false;
        // An upstream only unblocks once it is resolved (the same dependency-readiness
        // predicate the wave-planner uses, minus the merge-landing check we can't see
        // cheaply here — a resolved status is enough for the obstacle view).
        return !computeBlockerReadiness({
          isTerminal: isResolvedDependencyStatusView(b),
          workspaces: [],
        });
      });
    if (openBlockers.length === 0) continue;
    stalls.push({
      id: issue.id,
      issueNumber: issue.issueNumber,
      title: issue.title,
      statusName: issue.statusName,
      blockedBy: openBlockers.map((b) => ({ issueNumber: b.issueNumber, title: b.title })),
    });
  }

  // --- last cascade (most recent merge-category health event) ---
  const mergeEvents = await listBoardHealthEvents(
    { projectId, categories: ["merge"], limit: 1 },
    database,
  );
  const lastCascade = mergeEvents[0]
    ? {
        summary: mergeEvents[0].summary,
        issueNumber: mergeEvents[0].issueNumber,
        createdAt: mergeEvents[0].createdAt,
      }
    : null;

  // --- cold-build-clean status ---
  const coldCloneRaw = await getPreference(coldCloneCheckPrefKey(projectId), database);
  const verifyRaw = await getPreference(verifyScriptPrefKey(projectId), database);
  // Surface the most recent build/verify-related event from the error/server/launch
  // streams (a failed cold-clone build emits a session_failed/error event).
  const recentEvents = await listBoardHealthEvents(
    { projectId, eventTypes: ["error", "action", "observation"], limit: 40 },
    database,
  );
  const lastBuildEventRow = recentEvents.find((e) => BUILD_EVENT_RE.test(e.summary));

  const dashboard: DriveDashboard = {
    drive: {
      id: drive.id,
      projectId: drive.projectId,
      metaIssueId: drive.metaIssueId,
      target: drive.target,
      completionContract: drive.completionContract,
      status: drive.status,
      startedAt: drive.startedAt,
      finishedAt: drive.finishedAt,
    },
    progress: { total, done, inProgress, inReview, todo, percentDone },
    tiers,
    stalls,
    lastCascade,
    buildClean: {
      coldCloneGateEnabled: coldCloneRaw?.trim() === "true",
      verifyGateConfigured: !!(verifyRaw && verifyRaw.trim()),
      lastBuildEvent: lastBuildEventRow
        ? {
            summary: lastBuildEventRow.summary,
            issueNumber: lastBuildEventRow.issueNumber,
            createdAt: lastBuildEventRow.createdAt,
            eventType: lastBuildEventRow.eventType,
          }
        : null,
    },
  };
  return dashboard;
}
