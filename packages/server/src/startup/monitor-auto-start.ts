import { isTerminalStatusIdView } from "@agentic-kanban/shared";
import { issueDependencies, issues, issueTags, projectStatuses, tags, workflowNodes, workspaces } from "@agentic-kanban/shared/schema";
import { and, eq, sql, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { createBoardEvents } from "../services/board-events.js";
import type { MonitorActionName } from "../services/monitor-nudge.js";
import { resolveMonitorTunables } from "../services/strategy-objective.service.js";

/** Issues carrying this tag are an explicit opt-out of monitor auto-start. */
const SKIP_AUTO_START_TAG = "no-auto-start";

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
}

export async function runAutoStart(prefMap: Map<string, string>, { serverPort, boardEvents, logMonitorAction, allowProject }: AutoStartDeps) {
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
    const activeWipRows = await db.select({ count: sql<number>`count(distinct ${issues.id})` }).from(issues)
      .innerJoin(workspaces, eq(workspaces.issueId, issues.id))
      .where(sql`${issues.statusId} = ${inProgressSt.id} AND ${workspaces.status} != 'closed'`);
    let currentWip = Number(activeWipRows[0]?.count ?? 0);
    if (currentWip >= wipLimit) continue;

    const inProgressIssues = await db.select({ id: issues.id, title: issues.title, description: issues.description, issueNumber: issues.issueNumber }).from(issues)
      .where(eq(issues.statusId, inProgressSt.id));
    for (const issue of inProgressIssues) {
      if (currentWip >= wipLimit) break;
      if (startsRemaining(inProgressSt.projectId) <= 0) break;
      const openWs = await db.select({ id: workspaces.id }).from(workspaces)
        .where(sql`${workspaces.issueId} = ${issue.id} AND ${workspaces.status} != 'closed'`).limit(1);
      if (openWs.length > 0) continue;
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
    const inProgressCount = await db.select({ count: sql<number>`count(distinct ${issues.id})` }).from(issues)
      .innerJoin(workspaces, eq(workspaces.issueId, issues.id))
      .where(sql`${issues.statusId} = ${inProgressSt.id} AND ${workspaces.status} != 'closed'`);
    const currentWip = Number(inProgressCount[0]?.count ?? 0);
    if (currentWip >= wipLimit) continue;

    const todoStatus = await db.select({ id: projectStatuses.id }).from(projectStatuses)
      .where(sql`${projectStatuses.name} = 'Todo' AND ${projectStatuses.projectId} = ${inProgressSt.projectId}`).limit(1);
    if (todoStatus.length === 0) continue;

    const slotsAvailable = wipLimit - currentWip;
    const todoIssues = await db.select({ id: issues.id, title: issues.title, projectId: issues.projectId, issueNumber: issues.issueNumber }).from(issues)
      .where(eq(issues.statusId, todoStatus[0].id)).limit(Math.max(1, Math.min(slotsAvailable, startsRemaining(inProgressSt.projectId))) * 3);
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
      if (await hasSkipAutoStartTag(issue.id)) continue;

      const deps = await db.select({ dependsOnId: issueDependencies.dependsOnId }).from(issueDependencies)
        .where(sql`${issueDependencies.issueId} = ${issue.id} AND (${issueDependencies.type} = 'depends_on' OR ${issueDependencies.type} = 'blocked_by')`);
      if (deps.length > 0) {
        const blockerIds = deps.map((d) => d.dependsOnId);
        const blockerIssues = await db
          .select({
            statusId: issues.statusId,
            currentNodeId: issues.currentNodeId,
            currentNodeType: workflowNodes.nodeType,
          })
          .from(issues)
          .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
          .where(inArray(issues.id, blockerIds));

        const allResolved = blockerIssues.every((b) => isTerminalStatusIdView(b, doneStatusIds));
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
