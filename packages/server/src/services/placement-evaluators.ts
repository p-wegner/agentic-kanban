// One evaluator per placement-chain check (#755), split out of
// `placement-explain.service.ts` so that file stays under the god-module
// cohesion ceiling (#889) — this is pure per-check decision logic, and the
// facade re-exports what it needs from here unchanged.
//
// Each evaluator is a small function over a shared context; the driver in
// `placement-explain.service.ts` walks `PLACEMENT_CHECK_CHAIN` and stops at
// the first `decided`. Splitting it this way is not cosmetic: one function
// carrying every check inline measured 28 control-flow branches against the
// repo's per-function ceiling of 25 (#726), and a trivial driver is what
// makes "the ORDER comes from the chain constant" true rather than merely
// intended.
import {
  allowedProfilesPrefKey,
  remoteDispatchBlockedByAllowlist,
} from "@agentic-kanban/shared/lib/profile-allowlist";
import {
  remoteDispatchBlockedByDataHandling,
  requiredDataLabelsPrefKey,
} from "@agentic-kanban/shared/lib/profile-capabilities";
import { SHARES_FILESYSTEM_LABEL } from "@agentic-kanban/shared/lib/worker-protocol";

import type { Database } from "../db/index.js";
import { getProjectById } from "../repositories/project.repository.js";
import type { ProviderName } from "./agent-provider.js";
import type {
  BranchSource,
  PlacementCheckId,
  PlacementCheckOutcome,
  WorkerEligibility,
} from "../lib/placement-explain.types.js";
import { remoteDispatchBlockedByRepoShape } from "./worker-transport-support.service.js";
import {
  selectWorkerForLaunch,
  workerDispatchPrefKey,
  workerLabelsPrefKey,
  type FleetCapacity,
  type WorkerFleet,
} from "./worker-fleet.service.js";

export interface EvalContext {
  database: Database;
  projectId: string;
  providerName: ProviderName;
  branch?: string;
  branchSource: BranchSource;
  fleet: WorkerFleet;
  strict: boolean;
  optInPref: string | undefined;
  allowlistPref: string | undefined;
  dataHandlingPref: string | undefined;
  requiredLabels: string[];
  workers: WorkerEligibility[];
  capacity: FleetCapacity;
  now?: string;
  /** Filled by the eligible_worker check, consumed by the two transport checks. */
  workerId?: string;
  sharesFilesystem: boolean;
}

export interface CheckVerdict {
  outcome: PlacementCheckOutcome;
  detail: string;
  observed?: Record<string, string | number | boolean | null>;
  /** The resolver's own refusal wording, when this check decides. */
  refusalReason?: string;
  /** This check returns host even under strict dispatch (only check 1 does). */
  neverRefuses?: boolean;
}

export type Evaluator = (ctx: EvalContext) => Promise<CheckVerdict>;

const checkOptIn: Evaluator = async (ctx) => {
  const key = workerDispatchPrefKey(ctx.projectId);
  if (ctx.optInPref === "true") {
    return { outcome: "pass", detail: `${key} is "true"`, observed: { [key]: ctx.optInPref } };
  }
  const shown = ctx.optInPref === undefined ? "unset" : `"${ctx.optInPref}"`;
  return {
    outcome: "decided",
    // Strictness is never even read on this path in the resolver, so a strict
    // project that forgot the opt-in still runs on the host rather than refusing.
    neverRefuses: true,
    detail: `${key} is ${shown} — the project never asked for remote dispatch, so nothing was even considered`,
    observed: { [key]: ctx.optInPref ?? null },
  };
};

const checkAllowlist: Evaluator = async (ctx) => {
  const key = allowedProfilesPrefKey(ctx.projectId);
  const block = remoteDispatchBlockedByAllowlist(ctx.allowlistPref);
  const observed = { [key]: ctx.allowlistPref ?? null };
  if (!block.blocked) {
    return { outcome: "pass", detail: `${key} is empty, so the project is unrestricted`, observed };
  }
  return {
    outcome: "decided",
    detail:
      `${block.reason} — a worker authenticates the agent with its OWN local login, so the board can pick a ` +
      `permitted profile but cannot make a worker honour it (#651)`,
    observed,
    refusalReason: `project ${ctx.projectId} cannot dispatch remotely: ${block.reason}`,
  };
};

const checkDataHandling: Evaluator = async (ctx) => {
  const key = requiredDataLabelsPrefKey(ctx.projectId);
  const block = remoteDispatchBlockedByDataHandling(ctx.dataHandlingPref);
  const observed = { [key]: ctx.dataHandlingPref ?? null };
  if (!block.blocked) {
    return { outcome: "pass", detail: `${key} is empty, so the project is unrestricted`, observed };
  }
  return {
    outcome: "decided",
    detail:
      `${block.reason} — a worker authenticates the agent with its OWN local login, so the board can require a ` +
      `profile carry those tags but cannot make a worker honour it (#876)`,
    observed,
    refusalReason: `project ${ctx.projectId} cannot dispatch remotely: ${block.reason}`,
  };
};

function noEligibleWorkerDetail(ctx: EvalContext): string {
  if (ctx.workers.length === 0) {
    return "no worker is registered at all — pair one with `agentic-kanban worker pair`";
  }
  const labelPart = ctx.requiredLabels.length > 0 ? ` with labels [${ctx.requiredLabels.join(",")}]` : "";
  const perWorker = ctx.workers.map((w) => `${w.name} — ${w.ineligibleReason ?? "eligible"}`).join("; ");
  return `no eligible ${ctx.providerName} worker${labelPart}: ${perWorker}`;
}

const checkEligibleWorker: Evaluator = async (ctx) => {
  // The DECISION is the resolver's own NON-RESERVING selector; the per-worker
  // reasons are diagnostics layered on top of it. Calling the reserving variant
  // here would make an observability read consume the capacity it reports.
  const workerId = await selectWorkerForLaunch(ctx.fleet, ctx.providerName, ctx.requiredLabels, ctx.now);
  const observed = {
    [workerLabelsPrefKey(ctx.projectId)]: ctx.requiredLabels.join(",") || null,
    registeredWorkers: ctx.workers.length,
    eligibleWorkers: ctx.capacity.eligibleWorkers,
    freeSlots: ctx.capacity.freeSlots,
  };
  if (!workerId) {
    const labelPart = ctx.requiredLabels.length > 0 ? ` with labels [${ctx.requiredLabels.join(",")}]` : "";
    return {
      outcome: "decided",
      detail: noEligibleWorkerDetail(ctx),
      observed,
      refusalReason: `no eligible ${ctx.providerName} worker${labelPart}`,
    };
  }
  ctx.workerId = workerId;
  const chosen = ctx.workers.find((w) => w.workerId === workerId);
  ctx.sharesFilesystem = chosen?.sharesFilesystem === true;
  const eligibleCount = ctx.workers.filter((w) => w.eligible).length;
  // #910: name the headroom that actually decided, not just the outcome — `worker
  // explain` must show the values it read, and "least-loaded" alone stopped being the
  // whole story once headroom became the primary sort key.
  const headroomDetail = chosen?.capacity
    ? `, ${chosen.capacity.freeRamGb.toFixed(1)}GB free` +
      (chosen.capacity.thrashing !== "none" ? `, thrashing=${chosen.capacity.thrashing}` : "")
    : ", headroom unknown";
  return {
    outcome: "pass",
    detail:
      `worker ${workerId} selected (highest headroom${headroomDetail}, of ${eligibleCount} eligible)`,
    observed: {
      ...observed,
      ...(chosen?.capacity
        ? {
            selectedFreeRamGb: chosen.capacity.freeRamGb,
            selectedSpareCores: chosen.capacity.spareCores,
            selectedThrashing: chosen.capacity.thrashing,
          }
        : { selectedFreeRamGb: null, selectedSpareCores: null, selectedThrashing: null }),
    },
  };
};

const checkBranchForTransport: Evaluator = async (ctx) => {
  const observed = {
    branch: ctx.branch ?? null,
    branchSource: ctx.branchSource,
    sharesFilesystem: ctx.sharesFilesystem,
  };
  if (ctx.sharesFilesystem) {
    return {
      outcome: "skipped",
      detail:
        `worker ${ctx.workerId} carries the '${SHARES_FILESYSTEM_LABEL}' label, so it needs no git transport — ` +
        `checks 4 and 5 do not apply`,
      observed,
    };
  }
  if (ctx.branch) {
    return { outcome: "pass", detail: `branch '${ctx.branch}' (source: ${ctx.branchSource})`, observed };
  }
  return {
    outcome: "decided",
    detail: "no branch to push back — a direct workspace has nothing safe to land from another machine",
    observed,
    refusalReason: `remote worker ${ctx.workerId} needs a branch for git transport`,
  };
};

const checkRepoPath: Evaluator = async (ctx) => {
  if (ctx.sharesFilesystem) {
    return { outcome: "skipped", detail: "not applicable to a shares-filesystem worker", observed: {} };
  }
  const project = await getProjectById(ctx.projectId, ctx.database);
  const observed = { repoPath: project?.repoPath ?? null };
  if (project?.repoPath) {
    return {
      outcome: "pass",
      detail: `repoPath ${project.repoPath} will be served over the git transport port`,
      observed,
    };
  }
  return {
    outcome: "decided",
    detail: "project has no repoPath, so there is nothing to serve over git transport",
    observed,
    refusalReason: `project ${ctx.projectId} has no repoPath to serve over git transport`,
  };
};

const checkRepoTransportShape: Evaluator = async (ctx): Promise<CheckVerdict> => {
  if (ctx.sharesFilesystem) {
    return { outcome: "skipped", detail: "not applicable to a shares-filesystem worker", observed: {} };
  }
  const project = await getProjectById(ctx.projectId, ctx.database);
  if (!project?.repoPath) {
    // Unreachable in practice — check 5 decided already — but an evaluator must
    // never invent a pass it did not verify.
    return { outcome: "skipped", detail: "no repoPath to inspect", observed: {} };
  }
  const verdict = await remoteDispatchBlockedByRepoShape({
    projectId: ctx.projectId,
    repoPath: project.repoPath,
    database: ctx.database,
  });
  if (!verdict.blocked) {
    return {
      outcome: "pass",
      detail: "single repository, no LFS and no submodules — the git transport can carry it",
      observed: { repoPath: project.repoPath },
    };
  }
  return {
    outcome: "decided",
    detail: `${verdict.reason} (#748)`,
    observed: { repoPath: project.repoPath },
    refusalReason: `project ${ctx.projectId} cannot dispatch remotely: ${verdict.reason}`,
  };
};

export const EVALUATORS: Record<PlacementCheckId, Evaluator> = {
  dispatch_opt_in: checkOptIn,
  profile_allowlist: checkAllowlist,
  data_handling_requirement: checkDataHandling,
  eligible_worker: checkEligibleWorker,
  branch_for_transport: checkBranchForTransport,
  project_repo_path: checkRepoPath,
  repo_transport_shape: checkRepoTransportShape,
};
