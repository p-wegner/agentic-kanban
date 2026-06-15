import { computeBlockerReadiness, isTerminalStatusIdView, type BlockerWorkspaceLanding } from "@agentic-kanban/shared";
import { drives, issueDependencies, issues, issueTags, projectStatuses, tags, workflowNodes, workspaces } from "@agentic-kanban/shared/schema";
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
 * A workspace counts toward WIP only when it is genuinely running build/review/fix
 * work. The old `status != 'closed'`
 * check over-counted launch failures: a provider usage-limit launch lands the
 * workspace in `blocked`, and a zero-output launch failure lands it in `idle`
 * — neither has a live agent, yet both held WIP indefinitely, so the board
 * looked full while nothing was working (#690). Counting only active statuses
 * frees that capacity for auto-start.
 */
const AUTO_START_WIP_STATUSES = ["active", "reviewing", "fixing"] as const;
const activeWipPredicate = sql`${workspaces.status} IN (${sql.join(AUTO_START_WIP_STATUSES.map((s) => sql`${s}`), sql`, `)})`;

export interface WipCapacitySnapshot {
  active: number;
  inactiveStale: number;
}

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
  return (await countWipCapacity(database, inProgressStatusId)).active;
}

/**
 * Capacity diagnostics for the auto-start gate.
 *
 * `active` is the only value that consumes WIP slots. `inactiveStale` is reported
 * separately so lingering idle/closed/merged rows remain visible without blocking
 * the next unblocked ticket.
 */
export async function countWipCapacity(
  database: Pick<typeof db, "select">,
  inProgressStatusId: string,
): Promise<WipCapacitySnapshot> {
  const rows = await database.select({
    active: sql<number>`count(distinct CASE WHEN ${activeWipPredicate} THEN ${issues.id} END)`,
    inactiveStale: sql<number>`count(distinct CASE WHEN NOT (${activeWipPredicate}) THEN ${workspaces.id} END)`,
  }).from(issues)
    .innerJoin(workspaces, eq(workspaces.issueId, issues.id))
    .where(sql`${issues.statusId} = ${inProgressStatusId}`);
  const legacyCount = (rows[0] as { count?: number } | undefined)?.count;
  return {
    active: Number(rows[0]?.active ?? legacyCount ?? 0),
    inactiveStale: Number(rows[0]?.inactiveStale ?? 0),
  };
}

async function hasSkipAutoStartTag(issueId: string): Promise<boolean> {
  const rows = await db.select({ id: tags.id }).from(issueTags)
    .innerJoin(tags, eq(issueTags.tagId, tags.id))
    .where(and(eq(issueTags.issueId, issueId), eq(tags.name, SKIP_AUTO_START_TAG)))
    .limit(1);
  return rows.length > 0;
}

/**
 * A drive/epic META issue must NOT be auto-started as a builder (#824, #664). You don't *build* the
 * meta — its children are the buildable leaves; the meta is driven to Done by the drive lifecycle
 * once the children land. Auto-starting it spawns a stray builder workspace that drifts to In
 * Review and inflates WIP (starving real leaves). Two robust signals: (1) it's a first-class Drive
 * record's metaIssueId (#799), or (2) it is a parent of other issues via a parent_of/child_of edge.
 * (REST-seeded epics with neither still rely on the `no-auto-start` tag the drive skill applies.)
 */
export async function isDriveOrEpicMeta(issueId: string, database = db): Promise<boolean> {
  try {
    const driveRows = await database.select({ id: drives.id }).from(drives)
      .where(eq(drives.metaIssueId, issueId)).limit(1);
    if (driveRows.length > 0) return true;
    const childEdges = await database.select({ id: issueDependencies.id }).from(issueDependencies)
      .where(sql`(${issueDependencies.issueId} = ${issueId} AND ${issueDependencies.type} = 'parent_of') OR (${issueDependencies.dependsOnId} = ${issueId} AND ${issueDependencies.type} = 'child_of')`)
      .limit(1);
    return childEdges.length > 0;
  } catch {
    return false; // best-effort: a detection error must never block auto-start
  }
}

/**
 * SQL predicate that EXCLUDES drive/epic metas from the auto-start candidate query (#824). This is
 * the in-query enforcement of the same rule {@link isDriveOrEpicMeta} documents — applied as a WHERE
 * condition so a meta is never even a candidate (no per-issue query, no stray builder workspace).
 */
export function notDriveOrEpicMetaSql() {
  return sql`NOT EXISTS (SELECT 1 FROM ${drives} WHERE ${drives.metaIssueId} = ${issues.id})
    AND NOT EXISTS (SELECT 1 FROM ${issueDependencies} WHERE (${issueDependencies.issueId} = ${issues.id} AND ${issueDependencies.type} = 'parent_of') OR (${issueDependencies.dependsOnId} = ${issues.id} AND ${issueDependencies.type} = 'child_of'))`;
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
    const allowFeatureTypes = isAutoDrivenProject(inProgressSt.projectId);
    const wipLimit = tunablesFor(inProgressSt.projectId).activeAgentsTarget;
    const capacity = await countWipCapacity(db, inProgressSt.id);
    let currentWip = capacity.active;
    if (capacity.inactiveStale > 0) {
      console.log(`[monitor] Auto-start capacity for project ${inProgressSt.projectId}: active=${capacity.active}/${wipLimit} inactiveStale=${capacity.inactiveStale}`);
    }
    if (currentWip >= wipLimit) continue;

    const inProgressIssues = await db.select({ id: issues.id, title: issues.title, description: issues.description, issueType: issues.issueType, issueNumber: issues.issueNumber }).from(issues)
      .where(and(eq(issues.statusId, inProgressSt.id), notDriveOrEpicMetaSql())); // #824: don't backfill a builder onto a meta created directly In Progress
    for (const issue of inProgressIssues) {
      if (currentWip >= wipLimit) break;
      if (startsRemaining(inProgressSt.projectId) <= 0) break;
      const openWs = await db.select({ id: workspaces.id }).from(workspaces)
        .where(sql`${workspaces.issueId} = ${issue.id} AND ${workspaces.status} != 'closed'`).limit(1);
      if (openWs.length > 0) continue;
      if (!isMonitorEligibleIssue(issue, allowFeatureTypes)) continue;
      if (await hasSkipAutoStartTag(issue.id)) continue;
      const branchSlug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").substring(0, 40);
      const branch = `feature/ak-${issue.issueNumber}-${branchSlug}`;
      const prompt = issue.description ? `${issue.title}\n\n${issue.description}` : issue.title;
      const launchBody: Record<string, unknown> = { issueId: issue.id, branch, customPrompt: prompt };
      // Auto-driven projects must not stall in plan-only mode (#666).
      if (isAutoDrivenProject(inProgressSt.projectId)) launchBody.planMode = false;
      const resp = await fetch(`${baseUrl}/api/workspaces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(launchBody) }).catch((err) => {
        // #775: surface a thrown launch instead of swallowing it.
        console.warn(`[monitor] Auto-start launch threw for In Progress issue #${issue.issueNumber} (${issue.id}): ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
      // Count the slot as consumed regardless (we attempted a launch this cycle), but
      // only record SUCCESS as an auto_start action; a failed launch records a failure
      // (#775) so it is no longer invisible in the monitor logs / recentActions.
      currentWip++;
      noteStart(inProgressSt.projectId);
      if (!resp || !resp.ok) {
        const body = resp ? await resp.text().catch(() => "") : "";
        console.warn(`[monitor] Auto-start FAILED for In Progress issue #${issue.issueNumber} (${issue.id}): ${resp ? `HTTP ${resp.status} ${body.slice(0, 500)}` : "no response"}`);
        logMonitorAction("auto_start", "failed", issue.id);
        continue;
      }
      logMonitorAction("auto_start", "", issue.id);
      boardEvents.broadcast(inProgressSt.projectId, "board_changed");
      console.log(`[monitor] Auto-started workspace for In Progress issue #${issue.issueNumber} (no open workspace)`);
    }
  }

  for (const inProgressSt of inProgressStatuses) {
    const allowFeatureTypes = isAutoDrivenProject(inProgressSt.projectId);
    const wipLimit = tunablesFor(inProgressSt.projectId).activeAgentsTarget;
    const capacity = await countWipCapacity(db, inProgressSt.id);
    const currentWip = capacity.active;
    if (capacity.inactiveStale > 0) {
      console.log(`[monitor] Auto-start pull capacity for project ${inProgressSt.projectId}: active=${capacity.active}/${wipLimit} inactiveStale=${capacity.inactiveStale}`);
    }
    if (currentWip >= wipLimit) continue;

    const todoStatus = await db.select({ id: projectStatuses.id }).from(projectStatuses)
      .where(sql`${projectStatuses.name} = 'Todo' AND ${projectStatuses.projectId} = ${inProgressSt.projectId}`).limit(1);
    if (todoStatus.length === 0) continue;

    const slotsAvailable = wipLimit - currentWip;

    // For auto-driven projects, also pull Backlog issues so newly-created tickets
    // start without requiring a manual Backlog→Todo promotion (#536).
    const candidateStatusIds = [todoStatus[0].id];
    if (allowFeatureTypes) {
      const backlogStatus = await db.select({ id: projectStatuses.id }).from(projectStatuses)
        .where(sql`${projectStatuses.name} = 'Backlog' AND ${projectStatuses.projectId} = ${inProgressSt.projectId}`).limit(1);
      if (backlogStatus.length > 0) candidateStatusIds.push(backlogStatus[0].id);
    }

    // #774: do NOT pre-truncate the candidate set with an UNORDERED `limit(fetchLimit)`.
    // SQLite returns rows in an arbitrary order, so a small fetchLimit could return only
    // dep-blocked / already-workspaced candidates and silently DROP the one ticket whose
    // blockers are all Done+merged — exactly the ticket `dependency-waves/start-next`
    // launches correctly (it scans ALL issues, orders them, then filters). Fetch all
    // eligible candidates ordered by issue number (deterministic, FIFO-ish) and let the
    // per-issue gates below decide; the slotsAvailable / startsRemaining caps still bound
    // how many actually launch this cycle.
    // #773: skip the feature/enhancement type-exclusion for auto-driven projects.
    const todoIssues = await db.select({ id: issues.id, title: issues.title, description: issues.description, issueType: issues.issueType, projectId: issues.projectId, issueNumber: issues.issueNumber }).from(issues)
      .where(and(inArray(issues.statusId, candidateStatusIds), monitorEligibleIssueSql(allowFeatureTypes), notDriveOrEpicMetaSql()))
      .orderBy(issues.issueNumber);
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
      if (!isMonitorEligibleIssue(issue, allowFeatureTypes)) continue;
      if (await hasSkipAutoStartTag(issue.id)) continue;

      const deps = await db.select({ dependsOnId: issueDependencies.dependsOnId }).from(issueDependencies)
        .where(sql`${issueDependencies.issueId} = ${issue.id} AND (${issueDependencies.type} = 'depends_on' OR ${issueDependencies.type} = 'blocked_by')`);
      if (deps.length > 0) {
        const blockerIds = [...new Set(deps.map((d) => d.dependsOnId))];
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
        if (blockerIssues.length !== blockerIds.length) continue;

        // Dependency readiness is decided by the ONE shared `computeBlockerReadiness`
        // helper (also used by the dependency-wave planner) so the whole #535/#537/#782/#784
        // class is fixed in one place: a blocker unblocks its dependents only when it
        // reached a terminal status AND its work actually landed on the base branch
        // (`mergedAt`/`isDirect`), not merely when the issue is Done or its workspace closed.
        const blockerWorkspaces = await db
          .select({ issueId: workspaces.issueId, mergedAt: workspaces.mergedAt, isDirect: workspaces.isDirect })
          .from(workspaces)
          .where(inArray(workspaces.issueId, blockerIds));
        const wsByBlocker = new Map<string, BlockerWorkspaceLanding[]>();
        for (const w of blockerWorkspaces) {
          const list = wsByBlocker.get(w.issueId) ?? [];
          list.push({ mergedAt: w.mergedAt, isDirect: w.isDirect });
          wsByBlocker.set(w.issueId, list);
        }

        const allResolved = blockerIssues.every((b) => computeBlockerReadiness({
          isTerminal: isTerminalStatusIdView(b, doneStatusIds),
          workspaces: wsByBlocker.get(b.id) ?? [],
        }));
        if (!allResolved) continue;
      }

      const slug = issue.title.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, "-").slice(0, 40).replace(/-+$/, "");
      const branch = `feature/ak-${issue.issueNumber}-${slug}`;
      const launchBody: Record<string, unknown> = { issueId: issue.id, branch };
      // Auto-driven projects must not stall in plan-only mode (#666).
      if (isAutoDrivenProject(issue.projectId)) launchBody.planMode = false;
      const resp = await fetch(`${baseUrl}/api/workspaces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(launchBody) }).catch((err) => {
        // #775: surface a thrown launch (network/connection error) instead of silently
        // dropping it — record a failure action so it shows in the monitor logs.
        console.warn(`[monitor] Auto-start launch threw for issue "${issue.title}" (${issue.id}): ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
      if (resp?.ok) {
        const wsData = await resp.json().catch(() => null) as { id?: string } | null;
        logMonitorAction("auto_start", wsData?.id ?? "unknown", issue.id);
        console.log(`[monitor] Auto-started workspace for unblocked issue "${issue.title}" (${issue.id})`);
        boardEvents.broadcast(issue.projectId, "board_changed");
        started++;
        noteStart(inProgressSt.projectId);
      } else if (resp) {
        // #775: a non-ok response (e.g. HTTP 400 "No default branch") was previously
        // invisible — no log, no recorded action. Warn with the status + body and record
        // an auto_start action against the issue so the failure surfaces in recentActions.
        const body = await resp.text().catch(() => "");
        console.warn(`[monitor] Auto-start FAILED for issue "${issue.title}" (${issue.id}): HTTP ${resp.status} ${body.slice(0, 500)}`);
        logMonitorAction("auto_start", "failed", issue.id);
      }
    }
  }
}
