import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import type { DeliveryStatusResponse, RedBaseStatus } from "@agentic-kanban/shared/types";
import type { Database } from "../db/index.js";
import { getAllPreferences } from "../repositories/preferences.repository.js";
import { getLatestBaseBranchHealth } from "../repositories/base-branch-health.repository.js";
import { listOpenHealTickets } from "./base-health-heal-ticket.service.js";
import { resolveBaseRedVeto } from "./merge-train-base-veto.js";
import { describeBaseSweep, resolveRiskPosture, type RiskPosture } from "./risk-posture.service.js";
import { requireProject } from "./require-project.js";
import { resolveTrainWindowConfig } from "./merge-train-window.js";
import { readImpactMissRate } from "./test-impact-miss-rate.js";
import { currentRcCandidate, readRcState, resolveStableCheckoutFor, toRcCandidateSummary } from "./rc-state.js";

const trainMaxSizePref = projectPref("train_max_size");
const promoteCadencePref = projectPref("promote_cadence");

/**
 * `GET /api/projects/:id/delivery` — the resolved delivery-process read model (#1155) behind
 * the header chip: EFFECTIVE risk posture plus EFFECTIVE merge-train numbers, server-resolved
 * so the client never re-derives what the posture implies (the old `RiskPostureChip` used the
 * client's level-only resolver and was blind to the per-project red-base-policy and train-size
 * overrides). Modelled on `getAutopilotStatus`: read-only, one request, the numbers come
 * straight from the same resolvers the gate/merge code paths use.
 *
 * `redBase` (#1233) is the same shape of promise: `holdingWindow` is `resolveBaseRedVeto`'s
 * own verdict for this project, so the chip shows whether the train window is frozen by a red
 * base — and which policy decides that — from the exact function the orchestrator runs.
 */
export async function getDeliveryStatus(projectId: string, database: Database): Promise<DeliveryStatusResponse> {
  const project = await requireProject(projectId, database);

  const prefMap = toPrefMap(await getAllPreferences(database));
  const posture = resolveRiskPosture(prefMap, projectId);
  const trainWindow = resolveTrainWindowConfig(prefMap, projectId);
  const explicitTrainSize = Number.parseInt(prefMap.get(trainMaxSizePref.key(projectId)) ?? "", 10);
  const trainSizeFromOverride = Number.isFinite(explicitTrainSize) && explicitTrainSize > 0;
  const baseHealth = await getLatestBaseBranchHealth(projectId, database);
  const lastProbeAt = baseHealth?.createdAt ?? null;

  return {
    projectId,
    posture,
    trainSizeFromOverride,
    trainWindowMaxSize: trainWindow.maxSize,
    trainWindowMaxWaitMs: trainWindow.maxWaitMs,
    trainWindowFromPosture: trainWindow.batchingFromPosture,
    baseSweep: describeBaseSweep(posture, lastProbeAt),
    redBase: await describeRedBase(projectId, posture, baseHealth, database),
    // #1234 — read off the main checkout's `.test-impact/` files; null for a project without the skill.
    impactMissRate: readImpactMissRate(project.repoPath),
    // #1238 — the cadence as stored (absent reads as `off`), and the candidate most recently
    // touched, off the stable checkout's `.kanban/rc-state.json`. Both null-safe: a project not
    // run under the two-board setup has neither.
    promoteCadence: prefMap.get(promoteCadencePref.key(projectId)) ?? null,
    rc: toRcCandidateSummary(currentRcCandidate(readRcState(resolveStableCheckoutFor(project.repoPath)))),
  };
}

/** The red-base half of the read model — see `RedBaseStatus`. Never throws: an unreadable
 *  veto or ticket list reads as "not holding / none open" rather than failing the whole chip. */
async function describeRedBase(
  projectId: string,
  posture: RiskPosture,
  baseHealth: Awaited<ReturnType<typeof getLatestBaseBranchHealth>>,
  database: Database,
): Promise<RedBaseStatus> {
  const veto = await resolveBaseRedVeto(projectId, database, { posture }).catch(() => null);
  const openHealTickets = await listOpenHealTickets(projectId, database).catch(() => []);
  const outcome = baseHealth?.outcome;
  return {
    policy: posture.redBasePolicy,
    latestOutcome: outcome === "green" || outcome === "red" || outcome === "timeout" || outcome === "unverified" ? outcome : null,
    latestSha: baseHealth?.sha ?? null,
    holdingWindow: veto !== null,
    openHealTickets: openHealTickets.length,
  };
}
