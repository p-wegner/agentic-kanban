import { computeBlockerReadiness, isTerminalStatusIdView, suggestBranchName, type BlockerWorkspaceLanding } from "@agentic-kanban/shared";
import { drives, issueDependencies, issues, issueTags, projectStatuses, tags, workflowNodes, workspaces } from "@agentic-kanban/shared/schema";
import { and, eq, sql, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { createBoardEvents } from "../services/board-events.js";
import { parsePluginLoopUnitKey } from "@agentic-kanban/shared/lib/plugin-manifest";
import { reconcileMergedIssue } from "../services/merge-cleanup.service.js";
import type { MonitorActionName } from "../services/monitor-nudge.js";
import { resolveMonitorTunables } from "../services/strategy-objective.service.js";
import { narrowProviderName } from "../services/agent-provider.js";
import { projectCanDispatch } from "../services/worker-fleet.service.js";
import { shouldQuiesceBuildersForGate } from "../services/gate-quiesce.js";
import { isMonitorEligibleIssue, monitorEligibleIssueSql } from "./monitor-eligibility.js";
import { buildFileContentionGate, shouldDeferForContention, type BuildFileContentionGate } from "./monitor-file-contention.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

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

/**
 * Reasons the Backlog/Todo pull loop declined to start an otherwise-unblocked issue this
 * cycle. Tallied per project so a monitor-mode project that looks idle (#179) gets an
 * explained cause instead of silence — `dependency_unresolved` and "workspace already
 * open" are NOT tallied here because they are expected, self-explanatory states, not
 * surprises.
 */
export type AutoStartSkipReason =
  | "wip_cap"
  | "no_auto_start_tag"
  | "contention_gate"
  /**
   * A verify/build/smoke gate is running right now, so new builder STARTS are held for this
   * cycle (#581). Running agents are never touched — only the decision to add MORE load is
   * deferred. Measured: a gate at 6 workers competing with two builders failed three
   * real-git `mergeWorkspace` tests that pass in isolation, and the failure named a real
   * test with a plausible defect, so it cost a 55-minute gate plus two isolated re-runs to
   * classify as a flake. The monitor runs every few minutes, so the cost of holding is one
   * cycle of latency; the cost of not holding is a gate result nobody can trust.
   */
  | "verify_gate_running"
  | "cycle_start_cap"
  | "feature_type_excluded"
  /**
   * The project dispatches builders to fleet workers in STRICT mode (epic #184)
   * and no connected worker has free capacity. Skipping keeps the ticket queued
   * for a later cycle instead of quietly running it on the board host, which is
   * exactly what strict mode exists to prevent.
   */
  | "no_available_worker"
  /**
   * The issue already has a workspace with `mergedAt` set (its work landed on the base
   * branch) but the issue status never reached Done — the drift that let a hand-off drive
   * spawn a SECOND workspace for already-merged work (#190). Instead of starting a
   * duplicate, the issue is reconciled to Done here and no launch happens this cycle.
   */
  | "already_merged"
  /**
   * The issue is a PLUGIN-LOOP UNIT ticket whose workspace already merged, and the reopen-retry
   * path (#265) would have started a fresh workspace for it (#361).
   *
   * Measured on kassenbuch step-6: a unit that was merged (`cd4aae9`, `mergedAt` 20:06:58) AND
   * gate-approved (20:11:44) AND Done went back to In Progress at 20:18:22, got a whole second
   * workspace and branch (`…-skel-r2`, 20:22:16), and had both abandoned ~3 minutes later when the
   * ticket reverted to Done. Loop `openTickets` read 2 for 6m24s while `progress` reported that
   * same step `done`.
   *
   * Why declining is right regardless of WHAT set the status (still unproven, see the ticket): a
   * loop unit's identity is its `external_key`, and the loop's dedupe never re-plans a unit that
   * already has a ticket. So work done in a fresh workspace for that unit can never be represented
   * in the loop — while it inflates `openTickets`, the value the monitor gates advancing on, and
   * leaves a branch and a worktree behind. A loop that genuinely wants another pass at a subject
   * mints a FRESH unit id (a gate's "revise" action does exactly that); reopening the old ticket is
   * never how a loop asks for more work.
   */
  | "loop_unit_reopen_declined"
  /**
   * Another AUTOMATIC starter already holds the per-issue auto-start claim and is provisioning a
   * workspace for this issue right now (#366).
   *
   * The workspace row and the move to In Progress land in one transaction at the END of
   * provisioning (80s to 8+ minutes), so the table-based "does this issue already have an open
   * workspace?" check that every starter used is blind for that whole window. Two starters both
   * read "no workspace" and both provisioned. Measured live, on a server that already carried the
   * first fix: kassenbuch #9 got two workspaces sharing ONE worktree and branch (two agents
   * writing the same files concurrently for ~5 minutes), and linklocker #3 got three rows across
   * two branch slugs, leaving two full agent runs stranded on an unmerged branch.
   *
   * This is not a failure and not a consumed WIP slot — the OTHER starter's launch is the one
   * that counts, so the cycle records the decline and moves on.
   */
  | "create_in_flight";

export interface AutoStartSkipInfo {
  issueNumbers: number[];
  reasonCounts: Partial<Record<AutoStartSkipReason, number>>;
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
  /**
   * Builds the per-project shared-registration-file contention gate (#119).
   * Defaults to the real DB-backed builder, so production needs no wiring;
   * injectable so tests of unrelated auto-start logic can pass an open gate
   * instead of modelling this module's queries.
   */
  buildContentionGate?: BuildFileContentionGate;
  /**
   * Checks whether a strict worker-dispatch project has fleet capacity (epic #184).
   * Defaults to the real implementation, so production needs no wiring; injectable
   * for the same reason as `buildContentionGate` above — it reads preferences from
   * the DB, and suites that model `db.select` as an ORDERED mock chain would other-
   * wise have their sequence shifted by its reads. That desync is silent: it makes
   * "starts X" tests fail AND "does NOT start X" tests pass vacuously.
   */
  canDispatch?: typeof projectCanDispatch;
}

/**
 * Reconcile an issue whose work already landed (some workspace has `mergedAt` set) but
 * whose status is still non-terminal — instead of treating it as unstarted/backfillable
 * work and spawning a duplicate builder workspace for it (#190). Best-effort: a failure
 * here must not block the auto-start loop, so it only warns.
 */
async function reconcileStaleMergedIssue(
  projectId: string,
  issueId: string,
  issueNumber: number | null | undefined,
  boardEvents: ReturnType<typeof createBoardEvents>,
  noteSkip: (projectId: string, issueNumber: number | null | undefined, reason: AutoStartSkipReason) => void,
  mergedAt: string | null,
): Promise<{ reopenedAfterMerge: boolean }> {
  const label = issueNumber != null ? `#${issueNumber}` : issueId;
  try {
    // `mergedAt` makes this a CATCH-UP reconcile: a status that was changed AFTER the merge
    // is a deliberate reopen and must be left alone. Without it this sweep re-closed such a
    // ticket on EVERY cycle, silently undoing the operator.
    const { issueTransitioned, reopenedAfterMerge } = await reconcileMergedIssue({ database: db, issueId, projectId, mergedAt });
    if (reopenedAfterMerge) {
      // #265: the reopen is respected AND actionable. Previously this returned here and the
      // ticket sat in Todo forever on a monitor-driven project — the operator's reopen was
      // honoured but inert, needing a hand-made workspace. The caller now falls through to
      // the normal start path, which builds a FRESH branch (the merged one already contains
      // the landed work, so reusing it would give the agent nothing to do).
      console.log(`[monitor] Issue ${label} was reopened after its workspace merged — leaving its status alone and starting a fresh workspace for the reopened work`);
      return { reopenedAfterMerge: true };
    }
    if (issueTransitioned) {
      console.log(`[monitor] Reconciled issue ${label} to Done — its workspace was already merged but the issue status had not caught up; skipped starting a duplicate workspace (#190)`);
      boardEvents.broadcast(projectId, "board_changed");
    }
  } catch (err) {
    console.warn(`[monitor] Failed to reconcile already-merged issue ${label}:`, errorMessage(err));
  }
  noteSkip(projectId, issueNumber, "already_merged");
  return { reopenedAfterMerge: false };
}

/**
 * Branch for a reopen retry (#265). The deterministic `feature/ak-<N>-<slug>` name is already
 * taken by the merged workspace, so a retry needs its own — suffixed with the attempt number
 * derived from how many workspaces the issue already has. The old merged workspace is left
 * closed as history; nothing reuses or deletes it.
 */
function reopenRetryBranch(branch: string, priorWorkspaceCount: number): string {
  return `${branch}-r${priorWorkspaceCount + 1}`;
}

export async function runAutoStart(prefMap: Map<string, string>, { serverPort, boardEvents, logMonitorAction, allowProject, isAutoDrivenProject = () => false, buildContentionGate = buildFileContentionGate, canDispatch = projectCanDispatch }: AutoStartDeps): Promise<Map<string, AutoStartSkipInfo>> {
  const skipInfo = new Map<string, AutoStartSkipInfo>();
  const noteSkip = (projectId: string, issueNumber: number | null | undefined, reason: AutoStartSkipReason, count = 1) => {
    let info = skipInfo.get(projectId);
    if (!info) { info = { issueNumbers: [], reasonCounts: {} }; skipInfo.set(projectId, info); }
    if (issueNumber != null && !info.issueNumbers.includes(issueNumber)) info.issueNumbers.push(issueNumber);
    info.reasonCounts[reason] = (info.reasonCounts[reason] ?? 0) + count;
  };

  const baseUrl = `http://127.0.0.1:${serverPort}`;
  const inProgressStatuses = (await db.select({ id: projectStatuses.id, projectId: projectStatuses.projectId }).from(projectStatuses)
    .where(sql`${projectStatuses.name} = 'In Progress'`))
    .filter((s) => allowProject(s.projectId));
  if (inProgressStatuses.length === 0) return skipInfo;

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

    // Fleet gate (epic #184): a strict worker-dispatch project must not start
    // work the fleet cannot take — one check per project per cycle.
    const dispatch = await canDispatch({
      database: db,
      projectId: inProgressSt.projectId,
      providerName: narrowProviderName(prefMap.get("provider")),
    });
    if (!dispatch.available) {
      console.log(`[monitor] auto-start held for project ${inProgressSt.projectId}: ${dispatch.reason}`);
      noteSkip(inProgressSt.projectId, null, "no_available_worker");
      continue;
    }

    // #119: one snapshot per project per loop, then a cheap synchronous check per candidate.
    const contentionGate = await buildContentionGate(prefMap, inProgressSt.projectId);

    const inProgressIssues = await db.select({ id: issues.id, title: issues.title, description: issues.description, issueType: issues.issueType, issueNumber: issues.issueNumber, externalKey: issues.externalKey }).from(issues)
      .where(and(eq(issues.statusId, inProgressSt.id), notDriveOrEpicMetaSql())); // #824: don't backfill a builder onto a meta created directly In Progress
    for (const issue of inProgressIssues) {
      if (currentWip >= wipLimit) break;
      if (startsRemaining(inProgressSt.projectId) <= 0) break;
      const issueWorkspaces = await db.select({ id: workspaces.id, status: workspaces.status, mergedAt: workspaces.mergedAt }).from(workspaces)
        .where(sql`${workspaces.issueId} = ${issue.id}`);
      if (issueWorkspaces.some((w) => w.status !== "closed")) continue;
      const mergedWs = issueWorkspaces.find((w) => w.mergedAt != null);
      let isReopenRetry = false;
      if (mergedWs) {
        // #265: only a DELIBERATE reopen falls through to start again; a merged issue whose
        // status simply had not caught up is still reconciled and skipped as before.
        ({ reopenedAfterMerge: isReopenRetry } = await reconcileStaleMergedIssue(inProgressSt.projectId, issue.id, issue.issueNumber, boardEvents, noteSkip, mergedWs.mergedAt));
        if (!isReopenRetry) continue;
        // #361 — but never for a plugin-loop unit. See `loop_unit_reopen_declined`.
        if (parsePluginLoopUnitKey(issue.externalKey)) {
          console.log(`[monitor] Declining reopen-retry for plugin-loop unit issue #${issue.issueNumber} — its workspace already merged and the loop cannot represent a second one (#361)`);
          noteSkip(inProgressSt.projectId, issue.issueNumber, "loop_unit_reopen_declined");
          continue;
        }
      }
      if (!isMonitorEligibleIssue(issue, allowFeatureTypes)) continue;
      if (await hasSkipAutoStartTag(issue.id)) continue;
      if (shouldDeferForContention(contentionGate, issue.id, issue.issueNumber)) continue;
      // #366: ONE branch-name producer for the whole board (`suggestBranchName`). This site had
      // its own inline slug expression, and the Todo-pull loop below had a THIRD one that
      // stripped punctuation instead of turning it into `-` — that is where the observed
      // `8-9-ci-cd` vs `89-cicd` pair came from.
      const baseBranchName = suggestBranchName({ issueNumber: issue.issueNumber, title: issue.title });
      const branch = isReopenRetry ? reopenRetryBranch(baseBranchName, issueWorkspaces.length) : baseBranchName;
      const prompt = issue.description ? `${issue.title}\n\n${issue.description}` : issue.title;
      const launchBody: Record<string, unknown> = { issueId: issue.id, branch, customPrompt: prompt };
      // Auto-driven projects must not stall in plan-only mode (#666).
      if (isAutoDrivenProject(inProgressSt.projectId)) launchBody.planMode = false;
      // #269: `?async=1` — provisioning is minutes-long (measured 8+ min); a synchronous
      // launch blocked the whole monitor cycle for the duration. 202 + create-job instead.
      // #366: `&autoStart=1` — declare this an automatic starter so the route claims the issue
      // atomically and answers 409 when another starter is already provisioning it.
      const resp = await fetch(`${baseUrl}/api/workspaces?async=1&autoStart=1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(launchBody) }).catch((err) => {
        // #775: surface a thrown launch instead of swallowing it.
        console.warn(`[monitor] Auto-start launch threw for In Progress issue #${issue.issueNumber} (${issue.id}): ${errorMessage(err)}`);
        return null;
      });
      // #366: 409 means another automatic starter holds the claim and is provisioning this very
      // issue right now. That is not a failure and not a consumed slot — the other starter's
      // launch is the one that counts. Recorded as a skip so it stays visible.
      if (resp?.status === 409) {
        console.log(`[monitor] Auto-start declined for In Progress issue #${issue.issueNumber} — a workspace creation is already in flight for it (#366)`);
        noteSkip(inProgressSt.projectId, issue.issueNumber, "create_in_flight");
        continue;
      }
      // Count the slot as consumed regardless (we attempted a launch this cycle), but
      // only record SUCCESS as an auto_start action; a failed launch records a failure
      // (#775) so it is no longer invisible in the monitor logs / recentActions.
      currentWip++;
      noteStart(inProgressSt.projectId);
      contentionGate.noteStarted(issue.id);
      if (!resp || !resp.ok) {
        const body = resp ? await resp.text().catch(() => "") : "";
        console.warn(`[monitor] Auto-start FAILED for In Progress issue #${issue.issueNumber} (${issue.id}): ${resp ? `HTTP ${resp.status} ${body.slice(0, 500)}` : "no response"}`);
        logMonitorAction("auto_start", "failed", issue.id);
        continue;
      }
      logMonitorAction("auto_start", "", issue.id);
      boardEvents.broadcast(inProgressSt.projectId, "board_changed");
      // Same correction as below (#358): this is the 202 for an async create job, not a workspace.
      console.log(`[monitor] Auto-start ACCEPTED for In Progress issue #${issue.issueNumber} (no open workspace) — provisioning takes minutes`);
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

    // #581: hold new starts while a gate holds the build semaphore. Checked per project so
    // a project can opt out, but the resource being protected is the BOX — one project's
    // builder saturates another project's gate just as well.
    if (await shouldQuiesceBuildersForGate(inProgressSt.projectId, db)) {
      noteSkip(inProgressSt.projectId, null, "verify_gate_running");
      continue;
    }

    if (currentWip >= wipLimit) {
      // #179: WIP is full — but only worth surfacing as a "skipped" cause if there is
      // actually queued Todo/Backlog work waiting behind it, not on every idle project.
      const waitingTodoStatus = await db.select({ id: projectStatuses.id }).from(projectStatuses)
        .where(sql`${projectStatuses.name} = 'Todo' AND ${projectStatuses.projectId} = ${inProgressSt.projectId}`).limit(1);
      if (waitingTodoStatus.length > 0) {
        const waitingStatusIds = [waitingTodoStatus[0].id];
        if (allowFeatureTypes) {
          const backlogStatus = await db.select({ id: projectStatuses.id }).from(projectStatuses)
            .where(sql`${projectStatuses.name} = 'Backlog' AND ${projectStatuses.projectId} = ${inProgressSt.projectId}`).limit(1);
          if (backlogStatus.length > 0) waitingStatusIds.push(backlogStatus[0].id);
        }
        const waitingCount = await db.select({ count: sql<number>`count(*)` }).from(issues)
          .where(and(inArray(issues.statusId, waitingStatusIds), monitorEligibleIssueSql(allowFeatureTypes), notDriveOrEpicMetaSql()));
        const waiting = Number(waitingCount[0]?.count ?? 0);
        if (waiting > 0) noteSkip(inProgressSt.projectId, null, "wip_cap", waiting);
      }
      continue;
    }

    const todoStatus = await db.select({ id: projectStatuses.id }).from(projectStatuses)
      .where(sql`${projectStatuses.name} = 'Todo' AND ${projectStatuses.projectId} = ${inProgressSt.projectId}`).limit(1);
    if (todoStatus.length === 0) continue;

    const slotsAvailable = wipLimit - currentWip;
    // #119: snapshot once, then gate each candidate; launches this cycle feed back
    // via noteStarted so two backlog tickets sharing a registration file don't both
    // start in the SAME cycle.
    const contentionGate = await buildContentionGate(prefMap, inProgressSt.projectId);

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
    const todoIssues = await db.select({ id: issues.id, title: issues.title, description: issues.description, issueType: issues.issueType, projectId: issues.projectId, issueNumber: issues.issueNumber, externalKey: issues.externalKey }).from(issues)
      .where(and(inArray(issues.statusId, candidateStatusIds), monitorEligibleIssueSql(allowFeatureTypes), notDriveOrEpicMetaSql()))
      .orderBy(issues.issueNumber);
    const doneStatuses = await db.select({ id: projectStatuses.id }).from(projectStatuses)
      .where(sql`${projectStatuses.name} IN ('Done', 'Cancelled')`);
    const doneStatusIds = new Set(doneStatuses.map((s) => s.id));

    let started = 0;
    for (const issue of todoIssues) {
      if (started >= slotsAvailable) break;
      if (startsRemaining(inProgressSt.projectId) <= 0) {
        noteSkip(inProgressSt.projectId, issue.issueNumber, "cycle_start_cap");
        break;
      }
      const issueWorkspaces = await db.select({ id: workspaces.id, status: workspaces.status, mergedAt: workspaces.mergedAt }).from(workspaces)
        .where(sql`${workspaces.issueId} = ${issue.id}`);
      if (issueWorkspaces.some((w) => w.status !== "closed")) continue;
      const mergedWs = issueWorkspaces.find((w) => w.mergedAt != null);
      let isReopenRetry = false;
      if (mergedWs) {
        // #265: a deliberate reopen starts fresh work; a stale status is reconciled and skipped.
        ({ reopenedAfterMerge: isReopenRetry } = await reconcileStaleMergedIssue(issue.projectId, issue.id, issue.issueNumber, boardEvents, noteSkip, mergedWs.mergedAt));
        if (!isReopenRetry) continue;
        // #361 — same guard as the In-Progress backfill loop above. Both loops reach the reopen
        // retry, so guarding only one of them would leave the defect reachable by the other.
        if (parsePluginLoopUnitKey(issue.externalKey)) {
          console.log(`[monitor] Declining reopen-retry for plugin-loop unit issue #${issue.issueNumber} — its workspace already merged and the loop cannot represent a second one (#361)`);
          noteSkip(inProgressSt.projectId, issue.issueNumber, "loop_unit_reopen_declined");
          continue;
        }
      }
      if (!isMonitorEligibleIssue(issue, allowFeatureTypes)) { noteSkip(inProgressSt.projectId, issue.issueNumber, "feature_type_excluded"); continue; }
      if (await hasSkipAutoStartTag(issue.id)) { noteSkip(inProgressSt.projectId, issue.issueNumber, "no_auto_start_tag"); continue; }
      if (shouldDeferForContention(contentionGate, issue.id, issue.issueNumber)) { noteSkip(inProgressSt.projectId, issue.issueNumber, "contention_gate"); continue; }

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

      // #366: the THIRD slug producer used to live here — `[^a-z0-9\s] -> ""` instead of
      // `[^a-z0-9]+ -> "-"`, which is exactly what turned `PM pipeline 8/9: CI/CD & Deployment`
      // into `...-89-cicd-deployment` while `suggestBranchName` produced `...-8-9-ci-cd-deployment`
      // for the same issue. Both names were observed on duplicate workspaces of one issue.
      const baseBranchName = suggestBranchName({ issueNumber: issue.issueNumber, title: issue.title });
      const branch = isReopenRetry ? reopenRetryBranch(baseBranchName, issueWorkspaces.length) : baseBranchName;
      const launchBody: Record<string, unknown> = { issueId: issue.id, branch };
      // Auto-driven projects must not stall in plan-only mode (#666).
      if (isAutoDrivenProject(issue.projectId)) launchBody.planMode = false;
      // #269: `?async=1` — same as the backfill loop above; the cycle must not block
      // ~8 minutes per launch while the worktree provisions.
      // #366: `&autoStart=1` — claim the issue atomically; 409 = another starter has it.
      const resp = await fetch(`${baseUrl}/api/workspaces?async=1&autoStart=1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(launchBody) }).catch((err) => {
        // #775: surface a thrown launch (network/connection error) instead of silently
        // dropping it — record a failure action so it shows in the monitor logs.
        console.warn(`[monitor] Auto-start launch threw for issue "${issue.title}" (${issue.id}): ${errorMessage(err)}`);
        return null;
      });
      if (resp?.ok) {
        // Async launch (#269): the 202 body carries a create-job id, not a workspace id;
        // record whichever is available so the action stays traceable.
        const wsData = await resp.json().catch(() => null) as { id?: string; jobId?: string } | null;
        logMonitorAction("auto_start", wsData?.id ?? wsData?.jobId ?? "unknown", issue.id);
        // #358 — say what the 202 actually means. "Auto-started workspace" was logged here at the
        // moment the create JOB was accepted: at that instant no workspace row exists, the issue is
        // still in its pre-start lane, and no agent has been launched. Provisioning (worktree +
        // AWAITED blocking setup script + context packer) then runs for 84s-8min before the row and
        // the issue transition land in one transaction. That log line is the reason a working board
        // read as "an agent has been running for over a minute while the ticket says Backlog".
        console.log(`[monitor] Auto-start ACCEPTED for unblocked issue "${issue.title}" (${issue.id}) — provisioning a workspace (minutes); the issue moves to In Progress when it completes`);
        boardEvents.broadcast(issue.projectId, "board_changed");
        started++;
        noteStart(inProgressSt.projectId);
        contentionGate.noteStarted(issue.id);
      } else if (resp?.status === 409) {
        // #366: another automatic starter already holds the claim for this issue.
        console.log(`[monitor] Auto-start declined for unblocked issue "${issue.title}" (${issue.id}) — a workspace creation is already in flight for it (#366)`);
        noteSkip(inProgressSt.projectId, issue.issueNumber, "create_in_flight");
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

  return skipInfo;
}
