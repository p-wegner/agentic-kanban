import { and, eq, ne } from "drizzle-orm";
import { issues, preferences, projects, projectStatuses, workflowNodes, workspaces } from "@agentic-kanban/shared/schema";
import { isTerminalStatusView } from "@agentic-kanban/shared/lib/status-view";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "../services/board-events.js";

/** Pref key holding the marker for a project's last-announced completion state. */
export function projectCompletionMarkerKey(projectId: string): string {
  return `project_completed_announced_${projectId}`;
}

interface CompletionInput {
  /** Total issues belonging to the project. */
  totalIssues: number;
  /** Issues NOT in a terminal status/node (Backlog, In Progress, In Review, …). */
  openIssues: number;
  /** Open (non-closed) workspaces tied to the project — agents still running/reviewing/fixing. */
  openWorkspaces: number;
}

/**
 * A project is "finished" when its backlog is fully implemented: it has at least one
 * issue, none of them are open (every issue is Done/Cancelled/Archived or on an `end`
 * workflow node), and no workspace is still active (no agent mid-flight whose result
 * could re-open work). An empty project (no issues at all) is NOT "finished" — there
 * was never a backlog to implement.
 */
export function isProjectFinished(input: CompletionInput): boolean {
  return input.totalIssues > 0 && input.openIssues === 0 && input.openWorkspaces === 0;
}

/**
 * Detect when a project's backlog is fully implemented and inform the user (#848).
 *
 * Runs each auto-merge-orchestrator tick alongside the other reconcilers. For every
 * project it computes whether the project is "finished" (see isProjectFinished) and
 * compares against a stored marker (`project_completed_announced_<projectId>`):
 *
 *  - Rising edge (was not finished / never announced → finished): broadcast a
 *    `project_completed` board event so the client surfaces a notification, then set
 *    the marker to "true".
 *  - Falling edge (was announced finished → no longer finished, i.e. new work added):
 *    clear the marker so a later re-completion notifies again.
 *
 * The marker makes the announcement edge-triggered: the orchestrator ticks every ~30s,
 * but the user is only notified once per completion, not on every cycle. Pure detection
 * lives in isProjectFinished so it is unit-testable without a DB.
 *
 * Returns the number of projects whose completion state changed (announced or reset).
 */
export async function reconcileProjectCompletion(
  database: Database,
  opts: {
    boardEvents?: BoardEvents;
    /** Current time override for testing. */
    now?: string;
  } = {},
): Promise<number> {
  const now = opts.now ?? new Date().toISOString();

  const projectRows = await database.select({ id: projects.id }).from(projects);
  if (projectRows.length === 0) return 0;

  // Load all completion markers once.
  const markerRows = await database
    .select({ key: preferences.key, value: preferences.value })
    .from(preferences);
  const markerMap = new Map(markerRows.map((r) => [r.key, r.value]));

  let changed = 0;

  for (const project of projectRows) {
    const issueRows = await database
      .select({
        statusName: projectStatuses.name,
        currentNodeId: issues.currentNodeId,
        currentNodeType: workflowNodes.nodeType,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
      .where(eq(issues.projectId, project.id));

    const totalIssues = issueRows.length;
    const openIssues = issueRows.filter(
      (r) => !isTerminalStatusView({ statusName: r.statusName, currentNodeId: r.currentNodeId, currentNodeType: r.currentNodeType }),
    ).length;

    // Count open (non-closed) workspaces for this project — an agent still mid-flight
    // could re-open work, so a project with a live workspace is not yet finished.
    const openWorkspaceRows = await database
      .select({ id: workspaces.id })
      .from(workspaces)
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .where(and(eq(issues.projectId, project.id), ne(workspaces.status, "closed")));
    const openWorkspaces = openWorkspaceRows.length;

    const finished = isProjectFinished({ totalIssues, openIssues, openWorkspaces });
    const markerKey = projectCompletionMarkerKey(project.id);
    const alreadyAnnounced = markerMap.get(markerKey) === "true";

    if (finished && !alreadyAnnounced) {
      await database
        .insert(preferences)
        .values({ key: markerKey, value: "true", updatedAt: now })
        .onConflictDoUpdate({ target: preferences.key, set: { value: "true", updatedAt: now } });
      console.log(
        `[project-completion] project ${project.id} backlog fully implemented (${totalIssues} issues, all terminal, no open workspaces) — notifying user`,
      );
      opts.boardEvents?.broadcast(project.id, "project_completed");
      changed++;
    } else if (!finished && alreadyAnnounced) {
      // New work added (or work re-opened) after a completion — clear the marker so a
      // later re-completion notifies again.
      await database
        .insert(preferences)
        .values({ key: markerKey, value: "false", updatedAt: now })
        .onConflictDoUpdate({ target: preferences.key, set: { value: "false", updatedAt: now } });
      console.log(`[project-completion] project ${project.id} no longer finished — reset completion marker`);
      changed++;
    }
  }

  return changed;
}
