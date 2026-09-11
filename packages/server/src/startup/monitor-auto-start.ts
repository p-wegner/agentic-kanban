/**
 * Monitor AUTO-START: the entry that composes the two loops a cycle runs.
 *
 * #1021 cut this file along the seams the general architecture plan names (P3.2), because it
 * had grown past the 1000-line god-module ceiling `scripts/check-god-modules.mjs` enforces:
 *
 *  - `monitor-auto-start-cycle.ts` — the per-cycle context (`AutoStartCycle`), the host/fleet
 *    capacity questions and the per-issue gate chain (`evaluateStartCandidate`) BOTH loops run.
 *  - `monitor-todo-pull.ts` — the Todo/Backlog PULL loop with its candidate ordering, the
 *    dependency gate and the ticket-group expansion.
 *  - this file — the In-Progress BACKFILL loop and `runAutoStart`, which builds the cycle
 *    context once and sequences the two passes.
 *
 * The backfill stayed here deliberately: it is the shorter half, it shares every collaborator
 * with the orchestrator that sequences it, and moving it too would have left an entry that
 * only wires. Nothing about the split changes behaviour — same queries, same order, same
 * gates; the two passes still run un-interleaved, every project backfilled before any project
 * pulls.
 *
 * Existing importers are unaffected: the types and helpers that moved are re-exported below,
 * as this file already did for `monitor-start-holds.ts` and `wip-capacity.repository.ts`.
 */
import { suggestBranchName } from "@agentic-kanban/shared";
import { drives, issueDependencies, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { createBoardEvents } from "../services/board-events.js";
import type { MonitorActionName } from "../services/monitor-nudge.js";
import { resolveMonitorTunables } from "../services/strategy-objective.service.js";
import { resolveWipLimit } from "../services/wip-limit.service.js";
import { narrowProviderName } from "../services/agent-provider.js";
import { projectCanDispatch, hostOverflowHasFleetCapacity as defaultHasFleetOverflowCapacity } from "../services/worker-fleet.service.js";
import {
  recordFleetHold as recordFleetHoldDetail,
  recordMachineSaturationHold as recordMachineSaturationHoldDetail,
} from "./monitor-start-holds.js";
import { decideStartSlots } from "../services/start-slot-decision.js";
import { notDriveOrEpicMetaSql } from "../repositories/start-scoring.repository.js";
import { buildFileContentionGate, type BuildFileContentionGate } from "./monitor-file-contention.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { resolveMachineCapacity } from "@agentic-kanban/shared/lib/machine-capacity";
import {
  AUTO_START_WIP_STATUSES,
  SKIP_AUTO_START_TAG,
  countActiveWip,
  countWipCapacity,
  type WipCapacitySnapshot,
} from "../repositories/wip-capacity.repository.js";
import { orderCandidatesByStartScore } from "./monitor-start-scoring.js";
import { buildHarnessBudgetGate } from "./monitor-harness-budget.js";
// #919: recording a PROJECT-WIDE hold — its per-project tally, the per-ticket attribution that
// makes "why is #57 not running" answerable, and the end-of-cycle flush of both.
import {
  flushIssueSkipRecords,
  noteHeldCandidates,
} from "./monitor-skip-attribution.js";
import {
  evaluateStartCandidate,
  hasFleetOverflow,
  holdContext,
  isHostSaturated,
  reopenRetryBranch,
  type AutoStartCycle,
} from "./monitor-auto-start-cycle.js";
import { runTodoPull } from "./monitor-todo-pull.js";

/**
 * #1021 — the cycle context, the skip-reason vocabulary and the shared gate chain moved to
 * `monitor-auto-start-cycle.ts` (one cohesive concern: what a cycle knows and what every
 * candidate is asked). Re-exported so existing importers keep this path, exactly as the
 * `monitor-start-holds.ts` and `wip-capacity.repository.ts` re-exports below do.
 */
export type { AutoStartSkipReason, AutoStartSkipInfo, FleetHoldDetail, MachineSaturationDetail } from "./monitor-auto-start-cycle.js";
import type { AutoStartSkipInfo, AutoStartSkipReason } from "./monitor-auto-start-cycle.js";

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
 * #917: re-exported so existing importers keep this path — the implementation moved out
 * alongside `resolveCandidateStatusIds`, its usual co-caller. #942 moved that pair on again,
 * from `startup/monitor-eligibility.ts` into `repositories/start-scoring.repository.ts`: it
 * is candidate-selection SQL, not monitor-engine code, and while it sat in `startup/` the
 * read-only preview endpoint that needs it could only be reached through `startup/` — the
 * `server-route -> server-monitor` edge the pattern language forbids.
 */
export { notDriveOrEpicMetaSql };
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
  /**
   * One machine-capacity read for the whole cycle (#908). Defaults to the real
   * `resolveMachineCapacity`, so production needs no wiring; injectable for the same
   * reason as `canDispatch` above — the real Tier 0 reads this MACHINE'S actual free
   * memory, which a shared dev/CI box cannot guarantee stays above the 2GB default floor,
   * and a suite that hit that floor would non-deterministically start calling
   * `hostOverflowHasFleetCapacity` (another `db.select` reader) and desync every ordered
   * mock chain in this file's other test suites.
   */
  readMachineCapacity?: typeof resolveMachineCapacity;
  /**
   * Can this project's fleet absorb overflow from a saturated host (#908)? Defaults to
   * the real implementation; injectable for the same ordered-mock-chain reason as
   * `canDispatch` — it reads preferences from the DB.
   */
  hostOverflowHasFleetCapacity?: typeof defaultHasFleetOverflowCapacity;
  /**
   * #917: scores and sorts the Todo-pull candidate list in place. Defaults to the real
   * DB-backed `orderCandidatesByStartScore`, so production needs no wiring; injectable
   * for the same ordered-mock-chain reason as `buildContentionGate`/`canDispatch` above
   * — it reads `issueDependencies` (via `computeUnblockCounts`) and writes the score back
   * per candidate, and a suite modelling `db.select`/`db.update` as ordered mocks would
   * otherwise have its sequence shifted by those calls. Tests of unrelated auto-start
   * logic inject a no-op that leaves `candidates` in query order.
   */
  orderStartCandidates?: typeof orderCandidatesByStartScore;
  /** #1021's budget snapshot — injectable for the same ordered-mock reason (it reads via `db.select`). */
  buildHarnessGate?: typeof buildHarnessBudgetGate;
}
/**
 * BACKFILL loop: an issue already In Progress but with no open workspace gets one, up to
 * the project's WIP target. (The Todo pull loop below is the other half — it promotes
 * queued work INTO In Progress.)
 */
async function runInProgressBackfill(ctx: AutoStartCycle, inProgressSt: { id: string; projectId: string }): Promise<void> {
  const allowFeatureTypes = ctx.isAutoDrivenProject(inProgressSt.projectId);
  const wipLimit = ctx.wipLimitFor(inProgressSt.projectId);
  const capacity = await countWipCapacity(db, inProgressSt.id);
  let currentWip = capacity.active;
  if (capacity.inactiveStale > 0) {
    console.log(`[monitor] Auto-start capacity for project ${inProgressSt.projectId}: active=${capacity.active}/${wipLimit} inactiveStale=${capacity.inactiveStale}`);
  }
  // #1102: the slot arithmetic is `decideStartSlots`, shared with the pull loop and with
  // `GET /api/projects/:id/autopilot`. Asked twice so the async reads keep their order: the WIP
  // ceiling first (no I/O), then — after the fleet gate — the machine hold with the real
  // fleet-overflow answer.
  const { maxNewStartsPerCycle } = ctx.tunablesFor(inProgressSt.projectId);
  const slotInput = {
    wipLimit, active: currentWip, machineCapacity: ctx.machineCapacity, maxNewStartsPerCycle,
    startedThisCycle: maxNewStartsPerCycle - ctx.startsRemaining(inProgressSt.projectId),
  };
  if (decideStartSlots({ ...slotInput, fleetOverflow: false }).holdReason === "wip_full") return;

  // Fleet gate (epic #184): a strict worker-dispatch project must not start
  // work the fleet cannot take — one check per project per cycle.
  const dispatch = await ctx.canDispatch({
    database: db,
    projectId: inProgressSt.projectId,
    providerName: narrowProviderName(ctx.prefMap.get("provider")),
  });
  if (!dispatch.available) {
    // #774 — record the fleet's SHAPE alongside the collapsed reason, so the monitor
    // status carries what the console line used to be the only source of.
    await recordFleetHoldDetail(holdContext(ctx), inProgressSt.projectId, dispatch.reason);
    // #919: the project-wide hold is also the answer for every ticket queued behind it.
    await noteHeldCandidates(ctx, inProgressSt.projectId, allowFeatureTypes, "no_available_worker", ctx.database);
    return;
  }

  // #908: the host is a PLACEMENT input, not a gate — a saturated host still starts work
  // when this project's fleet can absorb it. Only skip when the host is tight AND there is
  // nowhere else to route the overflow.
  // #1019: the GRADED half of the same signal — even an unsaturated box may have room for
  // fewer agents than this project is configured for, and the clamp is what the loop runs at.
  const fleetOverflow = isHostSaturated(ctx.machineCapacity) && (await hasFleetOverflow(ctx, inProgressSt.projectId));
  const slots = decideStartSlots({ ...slotInput, fleetOverflow });
  const wipClamp = slots.clamp;
  if (slots.holdReason === "machine_full") {
    recordMachineSaturationHoldDetail(holdContext(ctx), inProgressSt.projectId, wipClamp.clamped ? wipClamp : undefined);
    // #919: attribute the project-wide hold to each ticket it is holding.
    await noteHeldCandidates(ctx, inProgressSt.projectId, allowFeatureTypes, "machine_saturated", ctx.database);
    return;
  }

  // #119: one snapshot per project per loop, then a cheap synchronous check per candidate.
  const contentionGate = await ctx.buildContentionGate(ctx.prefMap, inProgressSt.projectId);

  const inProgressIssues = await db.select({ id: issues.id, title: issues.title, description: issues.description, issueType: issues.issueType, issueNumber: issues.issueNumber, externalKey: issues.externalKey }).from(issues)
    .where(and(eq(issues.statusId, inProgressSt.id), notDriveOrEpicMetaSql())); // #824: don't backfill a builder onto a meta created directly In Progress
  for (const issue of inProgressIssues) {
    if (currentWip >= wipClamp.effective) break;
    if (ctx.startsRemaining(inProgressSt.projectId) <= 0) break;
    const decision = await evaluateStartCandidate({
      issue,
      reconcileProjectId: inProgressSt.projectId,
      skipProjectId: inProgressSt.projectId,
      allowFeatureTypes,
      contentionGate,
      boardEvents: ctx.boardEvents,
      noteSkip: ctx.noteSkip,
      // This loop never tallied the eligibility/tag/contention gates as skip reasons.
      noteGateSkip: () => {},
      noteIssueSkip: ctx.noteIssueSkip,
      database: ctx.database,
    });
    if (!decision.start) continue;
    // #366: ONE branch-name producer for the whole board (`suggestBranchName`). This site had
    // its own inline slug expression, and the Todo-pull loop below had a THIRD one that
    // stripped punctuation instead of turning it into `-` — that is where the observed
    // `8-9-ci-cd` vs `89-cicd` pair came from.
    const baseBranchName = suggestBranchName({ issueNumber: issue.issueNumber, title: issue.title });
    const branch = decision.isReopenRetry ? reopenRetryBranch(baseBranchName, decision.priorWorkspaceCount) : baseBranchName;
    const prompt = issue.description ? `${issue.title}\n\n${issue.description}` : issue.title;
    const launchBody: Record<string, unknown> = { issueId: issue.id, branch, customPrompt: prompt };
    // Auto-driven projects must not stall in plan-only mode (#666).
    if (ctx.isAutoDrivenProject(inProgressSt.projectId)) launchBody.planMode = false;
    // #269: `?async=1` — provisioning is minutes-long (measured 8+ min); a synchronous
    // launch blocked the whole monitor cycle for the duration. 202 + create-job instead.
    // #366: `&autoStart=1` — declare this an automatic starter so the route claims the issue
    // atomically and answers 409 when another starter is already provisioning it.
    const resp = await fetch(`${ctx.baseUrl}/api/workspaces?async=1&autoStart=1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(launchBody) }).catch((err) => {
      // #775: surface a thrown launch instead of swallowing it.
      console.warn(`[monitor] Auto-start launch threw for In Progress issue #${issue.issueNumber} (${issue.id}): ${errorMessage(err)}`);
      return null;
    });
    // #366: 409 means another automatic starter holds the claim and is provisioning this very
    // issue right now. That is not a failure and not a consumed slot — the other starter's
    // launch is the one that counts. Recorded as a skip so it stays visible.
    if (resp?.status === 409) {
      console.log(`[monitor] Auto-start declined for In Progress issue #${issue.issueNumber} — a workspace creation is already in flight for it (#366)`);
      ctx.noteSkip(inProgressSt.projectId, issue.issueNumber, "create_in_flight");
      ctx.noteIssueSkip(issue.id, "create_in_flight");
      continue;
    }
    // Count the slot as consumed regardless (we attempted a launch this cycle), but
    // only record SUCCESS as an auto_start action; a failed launch records a failure
    // (#775) so it is no longer invisible in the monitor logs / recentActions.
    currentWip++;
    ctx.noteStart(inProgressSt.projectId);
    contentionGate.noteStarted(issue.id);
    if (!resp || !resp.ok) {
      const body = resp ? await resp.text().catch(() => "") : "";
      console.warn(`[monitor] Auto-start FAILED for In Progress issue #${issue.issueNumber} (${issue.id}): ${resp ? `HTTP ${resp.status} ${body.slice(0, 500)}` : "no response"}`);
      ctx.logMonitorAction("auto_start", "failed", issue.id);
      continue;
    }
    ctx.logMonitorAction("auto_start", "", issue.id);
    ctx.noteIssueStarted(issue.id);
    ctx.boardEvents.broadcast(inProgressSt.projectId, "board_changed");
    // Same correction as below (#358): this is the 202 for an async create job, not a workspace.
    console.log(`[monitor] Auto-start ACCEPTED for In Progress issue #${issue.issueNumber} (no open workspace) — provisioning takes minutes`);
  }
}
export async function runAutoStart(prefMap: Map<string, string>, {
  serverPort, boardEvents, logMonitorAction, allowProject, isAutoDrivenProject = () => false,
  buildContentionGate = buildFileContentionGate, canDispatch = projectCanDispatch,
  readMachineCapacity = resolveMachineCapacity, hostOverflowHasFleetCapacity: hasFleetOverflowCapacity = defaultHasFleetOverflowCapacity,
  orderStartCandidates = orderCandidatesByStartScore, buildHarnessGate = buildHarnessBudgetGate,
}: AutoStartDeps): Promise<Map<string, AutoStartSkipInfo>> {
  const skipInfo = new Map<string, AutoStartSkipInfo>();
  const noteSkip = (projectId: string, issueNumber: number | null | undefined, reason: AutoStartSkipReason, count = 1) => {
    let info = skipInfo.get(projectId);
    if (!info) { info = { issueNumbers: [], reasonCounts: {} }; skipInfo.set(projectId, info); }
    if (issueNumber != null && !info.issueNumbers.includes(issueNumber)) info.issueNumbers.push(issueNumber);
    info.reasonCounts[reason] = (info.reasonCounts[reason] ?? 0) + count;
  };

  // #919: per-ISSUE skip reasons, buffered for the cycle and flushed once below. A `Map`, so
  // the LAST reason recorded for an issue wins — matching the column's contract ("the reason
  // the monitor most recently declined this ticket"), and keeping the flush one write per
  // issue however many gates it fell through.
  const issueSkips = new Map<string, AutoStartSkipReason>();
  const startedIssueIds = new Set<string>();
  const noteIssueSkip = (issueId: string, reason: AutoStartSkipReason) => { issueSkips.set(issueId, reason); };
  const noteIssueStarted = (issueId: string) => { startedIssueIds.add(issueId); issueSkips.delete(issueId); };

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
  // #919: the WIP target through THE resolver, cached per project for the same reason
  // `tunablesFor` is — both loops ask for it, and the answer cannot change mid-cycle.
  const wipLimitCache = new Map<string, number>();
  const wipLimitFor = (projectId: string) => {
    let limit = wipLimitCache.get(projectId);
    if (limit === undefined) { limit = resolveWipLimit(prefMap, projectId).limit; wipLimitCache.set(projectId, limit); }
    return limit;
  };
  const startedByProject = new Map<string, number>();
  const startsRemaining = (projectId: string) => tunablesFor(projectId).maxNewStartsPerCycle - (startedByProject.get(projectId) ?? 0);
  const noteStart = (projectId: string) => startedByProject.set(projectId, (startedByProject.get(projectId) ?? 0) + 1);

  // #908: ONE machine-capacity read for the whole cycle — see `AutoStartCycle.machineCapacity`
  // for why this is cached instead of read per project.
  const machineCapacity = await readMachineCapacity();

  const ctx: AutoStartCycle = {
    prefMap, database: db, baseUrl, boardEvents, logMonitorAction, isAutoDrivenProject,
    buildContentionGate, canDispatch, hasFleetOverflowCapacity, orderStartCandidates, buildHarnessGate, skipInfo, noteSkip, noteIssueSkip, noteIssueStarted, tunablesFor, wipLimitFor, startsRemaining, noteStart,
    machineCapacity,
  };

  // Two passes, in this order and NOT interleaved — unchanged from when both loop bodies
  // were inlined here: every project is backfilled before any project pulls new work.
  for (const inProgressSt of inProgressStatuses) {
    await runInProgressBackfill(ctx, inProgressSt);
  }

  for (const inProgressSt of inProgressStatuses) {
    await runTodoPull(ctx, inProgressSt);
  }

  await flushIssueSkipRecords(issueSkips, startedIssueIds, ctx.database);
  return skipInfo;
}

/**
 * #594 — re-exported so the many existing importers and the `monitor-auto-start-wip-capacity`
 * suite keep their import path while the implementation lives in `services/`.
 */
export {
  AUTO_START_WIP_STATUSES,
  SKIP_AUTO_START_TAG,
  countActiveWip,
  countWipCapacity,
  type WipCapacitySnapshot,
};
