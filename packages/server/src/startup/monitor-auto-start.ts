import { ACTIVE_WORKSPACE_STATUSES, isTerminalStatusIdView } from "@agentic-kanban/shared";
import { issueDependencies, issues, issueTags, projectStatuses, tags, workflowNodes, workspaces } from "@agentic-kanban/shared/schema";
import { and, eq, sql, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { createBoardEvents } from "../services/board-events.js";
import type { MonitorActionName } from "../services/monitor-nudge.js";
import { resolveMonitorTunables } from "../services/strategy-objective.service.js";
import { isMonitorEligibleIssue, monitorEligibleIssueSql } from "./monitor-eligibility.js";

/** Issues carrying this tag are an explicit opt-out of monitor auto-start. */
const SKIP_AUTO_START_TAG = "no-auto-start";

/**
 * SQL predicate matching workspaces that occupy ACTIVE agent capacity.
 *
 * A workspace counts toward WIP only when it is genuinely running an agent
 * (the canonical ACTIVE_WORKSPACE_STATUSES set). The old `status != 'closed'`
 * check over-counted launch failures: a provider usage-limit launch lands the
 * workspace in `blocked`, and a zero-output launch failure lands it in `idle`
 * — neither has a live agent, yet both held WIP indefinitely, so the board
 * looked full while nothing was working (#690). Counting only active statuses
 * frees that capacity for auto-start. This matches the capacity count used by
 * the sprint-capacity planner.
 */
const activeWipPredicate = sql`${workspaces.status} IN (${sql.join([...ACTIVE_WORKSPACE_STATUSES].map((s) => sql`${s}`), sql`, `)})`;

/**
 * Count distinct In-Progress issues whose workspace is ACTIVELY running an agent
 * for a single In-Progress status — the real WIP for auto-start decisions.
 *
 * Exported + database-injectable so the #690 regression can prove that a
 * usage-limit `blocked` workspace and a zero-output `idle` launch failure do
 * NOT inflate the count (they would have under the old `status != 'closed'`).
 */
export async function countActiveWip(
  database: Pick<typeof db, "select">,
  inProgressStatusId: string,
): Promise<number> {
  const rows = await database.select({ count: sql<number>`count(distinct ${issues.id})` }).from(issues)
    .innerJoin(workspaces, eq(workspaces.issueId, issues.id))
    .where(sql`${issues.statusId} = ${inProgressStatusId} AND ${activeWipPredicate}`);
  return Number(rows[0]?.count ?? 0);
}

async function hasSkipAutoStartTag(issueId: string): Promise<boolean> {
  const rows = await db.select({ id: tags.id }).from(issueTags)
    .innerJoin(tags, eq(issueTags.tagId, tags.id))
    .where(and(eq(issueTags.issueId, issueId), eq(tags.name, SKIP_AUTO_START_TAG)))
    .limit(1);
  return rows.length > 0;
}

export interface AutoStartDeps {
  serverPort: number;
  boardEvents: ReturnType<typeof createBoardEvents>;
  logMonitorAction: (action: MonitorActionName, workspaceId: string, issueId: string) => void;
  /**
   * Which projects this cycle may auto-start work for. The monitor passes a predicate
   * that is true when the global monitor is on (legacy behaviour, gated on
   * nudge_auto_start) OR the project has per-project hands-off mode enabled. This
   * replaces the old single global `nudge_auto_start` gate so a freshly-registered
   * project can drain its backlog without flipping a global switch.
   */
  allowProject: (projectId: string) => boolean;
  /**
   * Which projects have per-project hands-off (autodrive) mode explicitly enabled.
   * When true for a project, Backlog issues are treated as ready-to-start alongside
   * Todo issues — so new tickets created via UI/MCP/REST start without a manual
   * status promotion. Defaults to false (Backlog stays a triage area for non-driven projects).
   */
  isAutoDrivenProject?: (projectId: string) => boolean;
}

export async function runAutoStart(prefMap: Map<string, string>, { serverPort, boardEvents, logMonitorAction, allowProject, isAutoDrivenProject = () => false }: AutoStartDeps) {
  const baseUrl = `http://127.0.0.1:${serverPort}`;
  const inProgressStatuses = (await db.select({ id: projectStatuses.id, projectId: projectStatuses.projectId }).from(projectStatuses)
    .where(sql`${projectStatuses.name} = 'In Progress'`))
    .filter((s) => allowProject(s.projectId));
  if (inProgressStatuses.length === 0) return;

  // Per-project effective tunables (Strategy Bullseye when configured, else legacy
  // nudge prefs). `activeAgentsTarget` is the WIP target; `maxNewStartsPerCycle`
  // caps how many NEW workspaces a single cycle launches — counted across BOTH the
  // In-Progress backfill loop and the Todo→sprint pull loop below.
  const tunablesCache = new Map<string, ReturnType<typeof resolveMonitorTunables>["tunables"]>();
  const tunablesFor = (projectId: string) => {
    let t = tunablesCache.get(projectId);
    if (!t) { t = resolveMonitorTunables(prefMap, projectId).tunables; tunablesCache.set(projectId, t); }
    return t;
  };
  const startedByProject = new Map<string, number>();
  const startsRemaining = (projectId: string) => tunablesFor(projectId).maxNewStartsPerCycle - (startedByProject.get(projectId) ?? 0);
  const noteStart = (projectId: string) => startedByProject.set(projectId, (startedByProject.get(projectId) ?? 0) + 1);

  for (const inProgressSt of inProgressStatuses) {
    const wipLimit = tunablesFor(inProgressSt.projectId).activeAgentsTarget;
    let currentWip = await countActiveWip(db, inProgressSt.id);
    if (currentWip >= wipLimit) continue;

    const inProgressIssues = await db.select({ id: issues.id, title: issues.title, description: issues.description, issueType: issues.issueType, issueNumber: issues.issueNumber }).from(issues)
      .where(eq(issues.statusId, inProgressSt.id));
    for (const issue of inProgressIssues) {
      if (currentWip >= wipLimit) break;
      if (startsRemaining(inProgressSt.projectId) <= 0) break;
      const openWs = await db.select({ id: workspaces.id }).from(workspaces)
        .where(sql`${workspaces.issueId} = ${issue.id} AND ${workspaces.status} != 'closed'`).limit(1);
      if (openWs.length > 0) continue;
      if (!isMonitorEligibleIssue(issue)) continue;
      if (await hasSkipAutoStartTag(issue.id)) continue;
      const branchSlug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").substring(0, 40);
      const branch = `feature/ak-${issue.issueNumber}-${branchSlug}`;
      const prompt = issue.description ? `${issue.title}\n\n${issue.description}` : issue.title;
      await fetch(`${baseUrl}/api/workspaces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ issueId: issue.id, branch, customPrompt: prompt }) }).catch(() => {});
      currentWip++;
      noteStart(inProgressSt.projectId);
      logMonitorAction("auto_start", "", issue.id);
      boardEvents.broadcast(inProgressSt.projectId, "board_changed");
      console.log(`[monitor] Auto-started workspace for In Progress issue #${issue.issueNumber} (no open workspace)`);
    }
  }

  for (const inProgressSt of inProgressStatuses) {
    const wipLimit = tunablesFor(inProgressSt.projectId).activeAgentsTarget;
    const currentWip = await countActiveWip(db, inProgressSt.id);
    if (currentWip >= wipLimit) continue;

    const todoStatus = await db.select({ id: projectStatuses.id }).from(projectStatuses)
      .where(sql`${projectStatuses.name} = 'Todo' AND ${projectStatuses.projectId} = ${inProgressSt.projectId}`).limit(1);
    if (todoStatus.length === 0) continue;

    const slotsAvailable = wipLimit - currentWip;
    const fetchLimit = Math.max(1, Math.min(slotsAvailable, startsRemaining(inProgressSt.projectId))) * 3;

    // For auto-driven projects, also pull Backlog issues so newly-created tickets
    // start without requiring a manual Backlog→Todo promotion (#536).
    const candidateStatusIds = [todoStatus[0].id];
    if (isAutoDrivenProject(inProgressSt.projectId)) {
      const backlogStatus = await db.select({ id: projectStatuses.id }).from(projectStatuses)
        .where(sql`${projectStatuses.name} = 'Backlog' AND ${projectStatuses.projectId} = ${inProgressSt.projectId}`).limit(1);
      if (backlogStatus.length > 0) candidateStatusIds.push(backlogStatus[0].id);
    }

    const todoIssues = await db.select({ id: issues.id, title: issues.title, description: issues.description, issueType: issues.issueType, projectId: issues.projectId, issueNumber: issues.issueNumber }).from(issues)
      .where(and(inArray(issues.statusId, candidateStatusIds), monitorEligibleIssueSql())).limit(fetchLimit);
    const doneStatuses = await db.select({ id: projectStatuses.id }).from(projectStatuses)
      .where(sql`${projectStatuses.name} IN ('Done', 'Cancelled')`);
    const doneStatusIds = new Set(doneStatuses.map((s) => s.id));

    let started = 0;
    for (const issue of todoIssues) {
      if (started >= slotsAvailable) break;
      if (startsRemaining(inProgressSt.projectId) <= 0) break;
      const existingWs = await db.select({ id: workspaces.id }).from(workspaces)
        .where(sql`${workspaces.issueId} = ${issue.id} AND ${workspaces.status} != 'closed'`).limit(1);
      if (existingWs.length > 0) continue;
      if (!isMonitorEligibleIssue(issue)) continue;
      if (await hasSkipAutoStartTag(issue.id)) continue;

      const deps = await db.select({ dependsOnId: issueDependencies.dependsOnId }).from(issueDependencies)
        .where(sql`${issueDependencies.issueId} = ${issue.id} AND (${issueDependencies.type} = 'depends_on' OR ${issueDependencies.type} = 'blocked_by')`);
      if (deps.length > 0) {
        const blockerIds = deps.map((d) => d.dependsOnId);
        const blockerIssues = await db
          .select({
            id: issues.id,
            statusId: issues.statusId,
            currentNodeId: issues.currentNodeId,
            currentNodeType: workflowNodes.nodeType,
          })
          .from(issues)
          .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
          .where(inArray(issues.id, blockerIds));

        // A blocker only unblocks its dependents once its work is actually MERGED — not merely
        // when the issue reaches a terminal STATUS. A successful merge closes the workspace, so
        // an open (non-closed) workspace means the merge hasn't landed yet. Requiring "terminal
        // AND no open workspace" stops a dependent from auto-starting against a premature-Done
        // blocker (#535) and branching its worktree from a pre-merge base — which guaranteed
        // rebase conflicts (seen live: a dependent branched from the scaffold commit before its
        // blocker's merge landed). A terminal blocker with no workspace at all (manually done)
        // still counts as resolved.
        const openWsRows = await db.select({ issueId: workspaces.issueId }).from(workspaces)
          .where(and(inArray(workspaces.issueId, blockerIds), sql`${workspaces.status} != 'closed'`));
        const blockersWithOpenWorkspace = new Set(openWsRows.map((r) => r.issueId));

        const allResolved = blockerIssues.every(
          (b) => isTerminalStatusIdView(b, doneStatusIds) && !blockersWithOpenWorkspace.has(b.id),
        );
        if (!allResolved) continue;
      }

      const slug = issue.title.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, "-").slice(0, 40).replace(/-+$/, "");
      const branch = `feature/ak-${issue.issueNumber}-${slug}`;
      const resp = await fetch(`${baseUrl}/api/workspaces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ issueId: issue.id, branch }) }).catch(() => null);
      if (resp?.ok) {
        const wsData = await resp.json().catch(() => null) as { id?: string } | null;
        logMonitorAction("auto_start", wsData?.id ?? "unknown", issue.id);
        console.log(`[monitor] Auto-started workspace for unblocked issue "${issue.title}" (${issue.id})`);
        boardEvents.broadcast(issue.projectId, "board_changed");
        started++;
        noteStart(inProgressSt.projectId);
      }
    }
  }
}
