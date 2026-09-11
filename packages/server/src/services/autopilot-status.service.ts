import { resolveAutoMerge } from "@agentic-kanban/shared/lib/merge-policy";
import { resolveMachineCapacity, type MachineCapacitySnapshot } from "@agentic-kanban/shared/lib/machine-capacity";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import type { AutopilotHoldReason, AutopilotStatusResponse } from "@agentic-kanban/shared/types";
import type { Database } from "../db/index.js";
import { getAllPreferences } from "../repositories/preferences.repository.js";
import { hasSkipAutoStartTag, selectAutoStartCandidates, selectIssueWorkspaceStates } from "../repositories/auto-start.repository.js";
import {
  findProjectStatusIdByName,
  findStatusIdsByNames,
  isMonitorEligibleIssue,
  monitorEligibleIssueSql,
  notDriveOrEpicMetaSql,
  resolveCandidateStatusIds,
} from "../repositories/start-scoring.repository.js";
import { countWipCapacity, SKIP_AUTO_START_TAG } from "../repositories/wip-capacity.repository.js";
import { narrowProviderName } from "./agent-provider.js";
import { buildDependencyGate } from "./dependency-gate.service.js";
import { decideGateQuiesce, shouldQuiesceBuildersForGate } from "./gate-quiesce.js";
import { requireProject } from "./require-project.js";
import { decideStartSlots, type StartSlotDecision } from "./start-slot-decision.js";
import { resolveStartPolicy } from "./start-policy.service.js";
import { resolveMonitorTunables } from "./strategy-objective.service.js";
import { resolveWipLimit } from "./wip-limit.service.js";
import { hostOverflowHasFleetCapacity, projectCanDispatch } from "./worker-fleet.service.js";

/**
 * `GET /api/projects/:id/autopilot` — the toolbar Autopilot chip's one read (#1102).
 *
 * "Is this project on autopilot, how many agents is it running against what limit, will the next
 * cycle start anything, and will the result auto-merge?" used to need three places (the Monitor
 * popover, the Strategy Bullseye and Settings) and still did not answer the middle question at
 * all. This answers all four, and the "will start" number is NOT a second estimate: it replays the
 * monitor's own two passes through `decideStartSlots`, the function `runAutoStart`'s loops use —
 *
 *  1. the In-Progress BACKFILL (fleet gate, then the slot decision), then
 *  2. the Todo PULL (gate quiesce, then the slot decision with the backfill's starts already
 *     counted against the per-cycle cap — measured against the SAME active WIP, exactly as the
 *     pull loop recounts it before the backfill's async launches have created any row).
 *
 * "Ready" tickets are counted with the loops' cheap per-issue gates: no open workspace, not
 * already merged, monitor-eligible, no `no-auto-start` tag, and (pull only) dependency-unblocked.
 * Two gates are deliberately NOT replayed, so the prediction can be higher than what a cycle then
 * starts: the file-contention gate and the harness budget. Both need `startup/` snapshots a route
 * may not import, and both hold individual tickets rather than the project. A merged ticket that
 * was deliberately reopened (#265) is also not counted as ready.
 *
 * Read-only: nothing here writes, launches, or records a skip.
 */

/** At most this many ready tickets are confirmed per pass; the chip needs "enough", not a census. */
const ELIGIBLE_SCAN_LIMIT = 25;

export interface AutopilotStatusDeps {
  database: Database;
  readMachineCapacity?: () => Promise<MachineCapacitySnapshot>;
  canDispatch?: typeof projectCanDispatch;
  hasFleetOverflowCapacity?: typeof hostOverflowHasFleetCapacity;
  /** Is the host held for a running verify gate for this project (#581/#936)? */
  quiesceHostHeld?: (projectId: string, database: Database) => Promise<boolean>;
  /** When the in-process monitor's next cycle is due, if the caller knows. */
  nextCycleAt?: () => string | null;
}

interface Tally {
  count: number;
  capped: boolean;
}

async function countStartable<T>(candidates: readonly T[], isStartable: (candidate: T) => Promise<boolean>): Promise<Tally> {
  let count = 0;
  for (const candidate of candidates) {
    if (count >= ELIGIBLE_SCAN_LIMIT) return { count, capped: true };
    if (await isStartable(candidate)) count++;
  }
  return { count, capped: false };
}

/** The cheap per-issue gates `evaluateStartCandidate` applies, minus the contention snapshot. */
async function isReadyToStart(
  issue: { id: string; title: string; issueType: string | null },
  allowFeatureTypes: boolean,
  database: Database,
  passesDependencyGate?: (issueId: string) => Promise<boolean>,
): Promise<boolean> {
  const workspaces = await selectIssueWorkspaceStates(issue.id, database);
  if (workspaces.some((w) => w.status !== "closed")) return false;
  if (workspaces.some((w) => w.mergedAt != null)) return false;
  if (!isMonitorEligibleIssue(issue, allowFeatureTypes)) return false;
  if (await hasSkipAutoStartTag(issue.id, SKIP_AUTO_START_TAG, database)) return false;
  if (passesDependencyGate && !(await passesDependencyGate(issue.id))) return false;
  return true;
}

/**
 * DECISION (pure): the ONE hold worth showing on a chip. A start mode that is not `monitor` is the
 * answer whatever the numbers say; a project that will start something shows no hold; otherwise
 * the first project-wide hold that actually stopped work, else "nothing is ready".
 */
export function decideAutopilotHoldReason(input: {
  startMode: AutopilotStatusResponse["startMode"];
  willStart: number;
  hasInProgressStatus: boolean;
  backfill: StartSlotDecision;
  pullQuiesced: boolean;
  pullReady: number;
  dispatchAvailable: boolean;
  backfillReady: number;
}): AutopilotHoldReason | null {
  if (input.startMode === "manual") return "manual_mode";
  if (input.startMode === "conductor") return "conductor_mode";
  if (input.willStart > 0) return null;
  if (!input.hasInProgressStatus) return "no_ready_tickets";
  const slotHold = input.backfill.holdReason;
  if (slotHold === "wip_full" || slotHold === "machine_full" || slotHold === "start_cap") return slotHold;
  if (input.pullQuiesced && input.pullReady > 0) return "gate_running";
  if (!input.dispatchAvailable && input.backfillReady > 0) return "no_worker";
  return "no_ready_tickets";
}

export async function getAutopilotStatus(projectId: string, deps: AutopilotStatusDeps): Promise<AutopilotStatusResponse> {
  const { database } = deps;
  await requireProject(projectId, database);

  const prefMap = toPrefMap(await getAllPreferences(database));
  const policy = resolveStartPolicy(prefMap, projectId);
  const tunables = resolveMonitorTunables(prefMap, projectId).tunables;
  const wip = resolveWipLimit(prefMap, projectId);
  const autoMerge = resolveAutoMerge(prefMap, projectId);
  // The same two predicates `monitor-setup.ts` hands `runAutoStart`.
  const autoStart = policy.autoStartUnblocked;
  const allowFeatureTypes = policy.mode !== "manual";
  const providerName = narrowProviderName(prefMap.get("provider"));
  const overflowFn = deps.hasFleetOverflowCapacity ?? hostOverflowHasFleetCapacity;

  const inProgressStatusId = await findProjectStatusIdByName(projectId, "In Progress", database);
  const running = inProgressStatusId ? (await countWipCapacity(database, inProgressStatusId)).active : 0;
  const machineCapacity = await (deps.readMachineCapacity ?? (() => resolveMachineCapacity()))();
  const fleetOverflow = machineCapacity.hold && (await overflowFn({ database, projectId, providerName }));
  // Computed as if auto-started, so `slots` still tells a manual/conductor project what room it has.
  const slotInput = { wipLimit: wip.limit, active: running, machineCapacity, maxNewStartsPerCycle: tunables.maxNewStartsPerCycle, fleetOverflow };

  // Pass 1 — backfill: In Progress tickets with no workspace.
  const backfill = decideStartSlots({ ...slotInput, startedThisCycle: 0 });
  const dispatch = await (deps.canDispatch ?? projectCanDispatch)({ database, projectId, providerName });
  const backfillCandidates = inProgressStatusId
    ? await selectAutoStartCandidates([inProgressStatusId], [notDriveOrEpicMetaSql()], database)
    : [];
  const backfillReady = await countStartable(backfillCandidates, (issue) => isReadyToStart(issue, allowFeatureTypes, database));
  const backfillStarts = inProgressStatusId && dispatch.available ? Math.min(backfill.slots, backfillReady.count) : 0;

  // Pass 2 — pull: Todo (and Backlog on an auto-driven project), dependency-gated.
  const todoStatusId = inProgressStatusId ? await findProjectStatusIdByName(projectId, "Todo", database) : null;
  const hostHeld = await (deps.quiesceHostHeld ?? shouldQuiesceBuildersForGate)(projectId, database);
  const pullQuiesced = decideGateQuiesce({
    hostHeld,
    fleetOverflowAvailable: hostHeld ? await overflowFn({ database, projectId, providerName }) : false,
  }).action === "skip";
  const pull = decideStartSlots({ ...slotInput, startedThisCycle: backfillStarts });
  let pullReady: Tally = { count: 0, capped: false };
  if (todoStatusId) {
    const statusIds = await resolveCandidateStatusIds(projectId, todoStatusId, allowFeatureTypes, database);
    const candidates = await selectAutoStartCandidates(statusIds, [monitorEligibleIssueSql(allowFeatureTypes), notDriveOrEpicMetaSql()], database);
    const passesDependencyGate = buildDependencyGate(await findStatusIdsByNames(["Done", "Cancelled"], database), database);
    pullReady = await countStartable(candidates, (issue) => isReadyToStart(issue, allowFeatureTypes, database, passesDependencyGate));
  }
  const pullStarts = todoStatusId && !pullQuiesced ? Math.min(pull.slots, pullReady.count) : 0;

  const willStart = autoStart ? backfillStarts + pullStarts : 0;
  return {
    projectId,
    startMode: policy.mode,
    startModeSource: policy.source,
    autoStart,
    running,
    limit: wip.limit,
    limitConfigured: wip.configured !== null,
    effectiveLimit: backfill.effectiveLimit,
    startsPerCycle: tunables.maxNewStartsPerCycle,
    backlogFloor: tunables.backlogFloor,
    slots: backfill.slots,
    eligibleCount: backfillReady.count + pullReady.count,
    eligibleCountCapped: backfillReady.capped || pullReady.capped,
    willStartNextCycle: willStart,
    holdReason: decideAutopilotHoldReason({
      startMode: policy.mode,
      willStart,
      hasInProgressStatus: inProgressStatusId !== null,
      backfill,
      pullQuiesced,
      pullReady: pullReady.count,
      dispatchAvailable: dispatch.available,
      backfillReady: backfillReady.count,
    }),
    autoMerge: { enabled: autoMerge.enabled, source: autoMerge.source },
    nextCycleAt: deps.nextCycleAt?.() ?? null,
  };
}
