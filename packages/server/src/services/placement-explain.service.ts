// "Why was #N not dispatched to a worker?" (#755) — the placement decision as a
// RECORDED CHAIN, not a story told afterwards.
//
// Before this, the answer lived only in `console.warn` lines inside
// `resolveWorkerPlacement`: an operator asking why a project that opted into
// worker dispatch still ran on the board host had to read
// `worker-fleet.service.ts` and then guess which of six silent host fallbacks
// fired. Every one of them looks identical from the outside.
//
// TWO DESIGN RULES, because the obvious implementation is the wrong one:
//
//  1. THE CHAIN IS DATA, AND ITS ORDER IS PINNED TO THE RESOLVER'S SOURCE.
//     `PLACEMENT_CHECK_CHAIN` lists the checks in the order
//     `resolveWorkerPlacement` applies them, each carrying the step number of the
//     same check in `docs/worker-fleet.md` §7. `placement-chain-parity.test.ts`
//     re-derives both orders — from the resolver's own source text and from the
//     doc's numbered list — and fails when either drifts. It has already earned
//     its keep: #751 renamed the selector to `selectAndReserveWorkerForLaunch`
//     while this file was being written, and the test caught it immediately.
//
//  2. THE EXPLANATION IS CROSS-CHECKED AGAINST THE REAL RESOLVER AT RUNTIME.
//     `explainPlacement` evaluates the chain AND performs a read-only dry run of
//     `resolveWorkerPlacement` with the same inputs, then reports
//     `agreesWithResolver`. A reconstructed explanation drifts silently; this one
//     says so in its own payload. If the two ever disagree, the resolver is the
//     truth and the chain is the bug — the payload states exactly that instead of
//     handing the operator a confident wrong answer.
//
// This file deliberately does NOT own the decision and never edits it: the seam is
// observation (a non-reserving selector call plus a released dry run), so the
// resolver stays the single place a placement is decided.
import {
  allowedProfilesPrefKey,
} from "@agentic-kanban/shared/lib/profile-allowlist";
import {
  requiredDataLabelsPrefKey,
} from "@agentic-kanban/shared/lib/profile-capabilities";
import { SHARES_FILESYSTEM_LABEL } from "@agentic-kanban/shared/lib/worker-protocol";
import { compareWorkerBuild } from "@agentic-kanban/shared/lib/worker-build-freshness";
import { resolveOwnPackageVersion } from "../lib/worker-build.js";

import { db as realDb } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getPreferenceValue } from "../repositories/session-lifecycle.repository.js";
import {
  getIssueIdentityByNumber,
  getLatestWorkspaceBranchForIssue,
  getWorkerNamesByIds,
  listSessionPlacementRows,
} from "../repositories/placement-observability.repository.js";
import type { ProviderName } from "./agent-provider.js";
import type {
  BranchSource,
  FleetSnapshot,
  IssuePlacementReport,
  PlacementCheckId,
  PlacementCheckOutcome,
  PlacementCheckResult,
  PlacementExplanation,
  PlacementOutcome,
  PlacementReason,
  PlacementReasonId,
  SessionPlacementRecord,
  WorkerEligibility,
} from "../lib/placement-explain.types.js";

// Re-exported so existing importers of this service keep working; the declarations
// live in `lib/placement-explain.types.ts` so the worker binary's leaf consumers can
// depend on the shapes without this module's db graph (worker-cli-isolation guard).
export type {
  BranchSource,
  FleetSnapshot,
  IssuePlacementReport,
  PlacementCheckId,
  PlacementCheckOutcome,
  PlacementCheckResult,
  PlacementExplanation,
  PlacementOutcome,
  PlacementReason,
  PlacementReasonId,
  SessionPlacementRecord,
  WorkerEligibility,
};
import { isPlacementReasonId } from "../lib/placement-explain.types.js";
import { WorkerDispatchUnavailableError } from "./agent-dispatch.service.js";
import { releaseWorkerSlot } from "./worker-slot-reservation.service.js";
import {
  getWorkerFleet,
  parseRequiredLabels,
  resolveFleetCapacity,
  resolveWorkerPlacement,
  workerDispatchPrefKey,
  workerLabelsPrefKey,
  workerStrictPrefKey,
  type WorkerFleet,
} from "./worker-fleet.service.js";
import type { WorkerRegistry } from "./worker-registry.service.js";
import { loadProjectRuntimeConfig } from "./project-runtime-config.service.js";
import { resolveRiskPosture, riskPosturePrefKey } from "./risk-posture.service.js";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { EVALUATORS, type EvalContext } from "./placement-evaluators.js";


export interface PlacementCheckSpec {
  id: PlacementCheckId;
  /** Step number of this same check in docs/worker-fleet.md §7. Pinned by a test. */
  docStep: number;
  title: string;
  /** Distinctive text from `resolveWorkerPlacement` that performs this check. Pinned by a test. */
  resolverMarker: string;
  /** Must appear in the matching numbered item of docs/worker-fleet.md §7. Pinned by a test. */
  docMarker: RegExp;
  /** Preference keys an operator would change to make this check pass. */
  prefKeys: (projectId: string) => string[];
}

/**
 * The decision chain, in the order `resolveWorkerPlacement` applies it.
 *
 * `shares-filesystem` workers skip the last three entirely — that is not another
 * check but a short circuit, reported on the `branch_for_transport` result.
 */
export const PLACEMENT_CHECK_CHAIN: readonly PlacementCheckSpec[] = [
  {
    id: "dispatch_opt_in",
    docStep: 1,
    title: "Project opted into worker dispatch",
    resolverMarker: "workerDispatchPrefKey(projectId)",
    docMarker: /worker_dispatch_<projectId>/,
    prefKeys: (projectId) => [workerDispatchPrefKey(projectId)],
  },
  {
    id: "profile_allowlist",
    docStep: 2,
    title: "Project has no profile allowlist",
    resolverMarker: "allowedProfilesPrefKey(projectId)",
    docMarker: /allowed_profiles_<projectId>/,
    prefKeys: (projectId) => [allowedProfilesPrefKey(projectId)],
  },
  {
    // #876 — same shape as the allowlist check above, one step later in the resolver.
    id: "data_handling_requirement",
    docStep: 3,
    title: "Project has no data-handling requirement (no-training, eu-data-residency, ...)",
    resolverMarker: "requiredDataLabelsPrefKey(projectId)",
    docMarker: /required_data_labels_<projectId>/,
    prefKeys: (projectId) => [requiredDataLabelsPrefKey(projectId)],
  },
  {
    // #937 / decision 017 — the risk posture's `placementBias`. Only `host-half` (i.e.
    // `strict`) decides here; `host-preferred`/`remote-preferred` are preferences and pass.
    id: "placement_bias",
    docStep: 4,
    title: "Project's risk posture allows remote placement (placementBias is not 'host-half')",
    resolverMarker: "remoteDispatchBlockedByPlacementBias(",
    docMarker: /placementBias|risk posture/i,
    prefKeys: (projectId) => [riskPosturePrefKey(projectId)],
  },
  {
    id: "eligible_worker",
    docStep: 5,
    title: "An eligible worker has a free slot",
    resolverMarker: "selectAndReserveWorkerForLaunch(",
    docMarker: /No eligible worker/i,
    prefKeys: (projectId) => [workerLabelsPrefKey(projectId)],
  },
  {
    id: "branch_for_transport",
    docStep: 6,
    title: "There is a branch to push back over git transport",
    resolverMarker: "if (!branch)",
    docMarker: /No branch to push back/i,
    prefKeys: () => [],
  },
  {
    id: "project_repo_path",
    docStep: 7,
    title: "Project has a repoPath to serve over git transport",
    resolverMarker: "project?.repoPath",
    docMarker: /no `?repoPath`?/i,
    prefKeys: () => [],
  },
  {
    // #748 landed this guard WHILE this file was being written, and the runtime
    // cross-check is how it was found: the chain said "remote", the resolver said
    // "host", and `agreesWithResolver` reported the disagreement instead of the
    // explanation quietly over-promising. That is the whole argument for rule 2 in
    // this file's header, demonstrated on its first day.
    id: "repo_transport_shape",
    docStep: 8,
    title: "Repository shape fits the single-repo git transport (no siblings, LFS or submodules)",
    resolverMarker: "remoteDispatchBlockedByRepoShape(",
    docMarker: /git transport carries ONE repository|repository shape/i,
    prefKeys: () => [],
  },
] as const;







function parseJsonList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Why THIS worker is not a candidate — the first failing condition. Deliberately
 * NOT the decision (that comes from `selectWorkerForLaunch`): it is the detail an
 * operator cannot see today, because all five eligibility failures print the same
 * "no eligible worker".
 */
function ineligibleReasonFor(
  worker: { effectiveStatus: string; providers: string | null; maxConcurrency: number },
  ctx: {
    connected: boolean;
    load: number;
    providers: string[];
    missingLabels: string[];
    providerName: ProviderName;
    unresponsive: string | null;
  },
): string | null {
  if (worker.effectiveStatus !== "online") {
    return `status is ${worker.effectiveStatus} (heartbeat too old, or draining)`;
  }
  if (!ctx.connected) return "heartbeat is fresh but the board holds no WebSocket for it";
  // #901 — the failure the two checks above cannot see: both are answered by the daemon's
  // transport layer, which outlives its ability to launch anything.
  if (ctx.unresponsive) return ctx.unresponsive;
  if (worker.providers && ctx.providers.length > 0 && !ctx.providers.includes(ctx.providerName)) {
    return `does not advertise provider '${ctx.providerName}' (has [${ctx.providers.join(",")}])`;
  }
  if (ctx.missingLabels.length > 0) return `missing required label(s) [${ctx.missingLabels.join(",")}]`;
  if (ctx.load >= worker.maxConcurrency) return `no free slot (${ctx.load}/${worker.maxConcurrency} in use)`;
  return null;
}

async function describeWorkers(
  fleet: WorkerFleet,
  providerName: ProviderName,
  requiredLabels: string[],
  now?: string,
): Promise<WorkerEligibility[]> {
  const workers = await fleet.registry.listWorkersView(now);
  return workers.map((w) => {
    const labels = parseJsonList(w.labels);
    const connected = fleet.connections.isConnected(w.id);
    const load = fleet.connections.assignedSessionIds(w.id).length;
    const reason = ineligibleReasonFor(w, {
      connected,
      load,
      providers: parseJsonList(w.providers),
      missingLabels: requiredLabels.filter((l) => !labels.includes(l)),
      providerName,
      unresponsive: fleet.health.unresponsiveReason(w.id),
    });
    return {
      workerId: w.id,
      name: w.name,
      effectiveStatus: w.effectiveStatus,
      connected,
      load,
      maxConcurrency: w.maxConcurrency,
      sharesFilesystem: labels.includes(SHARES_FILESYSTEM_LABEL),
      eligible: reason === null,
      ineligibleReason: reason,
      // #774 — the identity half. `GET /api/workers` is served from this shape now, so the
      // route no longer hands out the raw row and the panel no longer computes a second,
      // wrong "capacity" from it.
      os: w.os,
      arch: w.arch,
      labels,
      providers: parseJsonList(w.providers),
      status: w.status,
      lastHeartbeatAt: w.lastHeartbeatAt,
      ...(w.protocolVersion === undefined ? {} : { protocolVersion: w.protocolVersion }),
      // #879: freshness rides ONLY on a reported build. A worker that reported nothing
      // keeps rendering as `?` — "we assumed" and "it said" are different facts, and a
      // fabricated "current" here would launder the first into the second.
      ...(w.workerVersion === undefined
        ? {}
        : {
            workerVersion: w.workerVersion,
            buildFreshness: compareWorkerBuild(w.workerVersion, resolveOwnPackageVersion()),
          }),
      assignedSessionIds: fleet.connections.assignedSessionIds(w.id),
      freeSlots: Math.max(0, w.maxConcurrency - load),
      // #910: the headroom placement actually compared, not just its outcome.
      ...(w.capacity ? { capacity: w.capacity } : {}),
    };
  });
}

/**
 * The fleet as one snapshot (#774), for `GET /api/workers` and the panel.
 *
 * The point is that this is the SAME computation the placement explanation uses: before
 * this, the list route returned the `workers` row untouched and `WorkerFleetPanel`
 * derived "capacity" as the sum of `maxConcurrency` over heartbeat-online workers — a
 * number that reads as free capacity while every slot is busy, and that counts a worker
 * whose heartbeat is fresh but whose WebSocket the board does not hold. `freeSlots` here
 * is the resolver's own `resolveFleetCapacity`.
 *
 * `projectId` is optional because the fleet exists independently of any project: without
 * one there are no required labels, and eligibility is reported for `providerName` alone.
 */
export async function describeFleet(params: {
  database?: Database;
  projectId?: string;
  providerName?: ProviderName;
  now?: string;
  /**
   * The registry to read, when the caller holds one that is not the per-database singleton
   * (#799, fixing #774 fallout).
   *
   * `createWorkersRoute` takes an injectable registry, and #774 moved `GET /api/workers` onto
   * this function — which reached for the singleton and so IGNORED the injection. In production
   * both are the same object, which is why it went unnoticed; against an injected registry the
   * route answered from a DIFFERENT instance, so everything held in the registry's own memory
   * rather than in the DB (the reported protocol/build versions, #754) read as absent. An
   * injection seam that only one route honours is not a seam.
   */
  registry?: WorkerRegistry;
}): Promise<FleetSnapshot> {
  const database = params.database ?? realDb;
  const providerName = params.providerName ?? "claude";
  const singleton = getWorkerFleet(database);
  const fleet: WorkerFleet = params.registry ? { ...singleton, registry: params.registry } : singleton;
  const requiredLabels = params.projectId
    ? parseRequiredLabels(await getPreferenceValue(workerLabelsPrefKey(params.projectId), database))
    : [];
  const workers = await describeWorkers(fleet, providerName, requiredLabels, params.now);
  const capacity = await resolveFleetCapacity(fleet, providerName, requiredLabels, params.now);
  return {
    registered: workers.length,
    online: workers.filter((w) => w.effectiveStatus === "online").length,
    connected: workers.filter((w) => w.connected).length,
    eligible: capacity.eligibleWorkers,
    freeSlots: capacity.freeSlots,
    provider: providerName,
    requiredLabels,
    boardWorkerVersion: resolveOwnPackageVersion() ?? null,
    workers,
  };
}

function notReached(spec: PlacementCheckSpec, projectId: string): PlacementCheckResult {
  return {
    id: spec.id,
    docStep: spec.docStep,
    title: spec.title,
    outcome: "not-reached",
    detail: "not evaluated — an earlier check already decided the placement",
    observed: {},
    prefKeys: spec.prefKeys(projectId),
  };
}

/**
 * Run the real resolver as a read-only dry run and normalise its answer.
 *
 * Deliberately passes NO `hostCapacity` (#938), so the host is not ranked in and this dry
 * run compares like-for-like against the guard chain above. Two reasons. The explanation
 * answers "why does nothing dispatch" — a question about the guards, each of which names a
 * setting an operator can change; a headroom comparison names nothing to change and would
 * arrive as a spurious `agreesWithResolver: false` whenever the board happened to have more
 * free RAM than the fleet at that instant. And the honest answer moves between two calls a
 * second apart, which is not something to pin a static chain against.
 */
async function dryRunResolver(params: {
  database: Database;
  projectId: string;
  providerName: ProviderName;
  branch?: string;
  baseBranch?: string;
  now?: string;
}): Promise<PlacementOutcome> {
  try {
    const placement = await resolveWorkerPlacement(params);
    if (placement.kind !== "remote") return { kind: "host" };
    // #751 made a remote placement CLAIM a capacity slot, so the dry run is only
    // read-only if it gives that slot straight back. Without this, asking "why was
    // #N not dispatched" about a project that CAN dispatch would pin a worker slot
    // until the reservation TTL expired — an observability call that degrades the
    // thing it observes.
    releaseWorkerSlot(placement.reservationId);
    return { kind: "remote", workerId: placement.workerId };
  } catch (err) {
    if (err instanceof WorkerDispatchUnavailableError) return { kind: "refused", message: err.message };
    throw err;
  }
}

function summarize(
  decidedBy: PlacementCheckId | null,
  predicted: PlacementOutcome,
  chain: PlacementCheckResult[],
): string {
  if (!decidedBy) {
    const target = predicted.kind === "remote" ? `worker ${predicted.workerId}` : "a worker";
    return `Dispatches remotely to ${target}.`;
  }
  const step = chain.find((c) => c.id === decidedBy);
  const verb = predicted.kind === "refused" ? "REFUSED (strict dispatch)" : "ran on the board HOST";
  return `${verb} — decided at check ${step?.docStep} (${step?.title}): ${step?.detail}`;
}

async function buildEvalContext(params: {
  database: Database;
  projectId: string;
  providerName: ProviderName;
  branch?: string;
  branchSource?: BranchSource;
  now?: string;
}): Promise<EvalContext> {
  const { database, projectId, providerName, branch, now } = params;
  const fleet = getWorkerFleet(database);
  const requiredLabels = parseRequiredLabels(await getPreferenceValue(workerLabelsPrefKey(projectId), database));
  return {
    database,
    projectId,
    providerName,
    branch,
    branchSource: params.branchSource ?? (branch ? "workspace" : "none"),
    fleet,
    strict: (await getPreferenceValue(workerStrictPrefKey(projectId), database)) === "true",
    optInPref: await getPreferenceValue(workerDispatchPrefKey(projectId), database),
    allowlistPref: await getPreferenceValue(allowedProfilesPrefKey(projectId), database),
    dataHandlingPref: await getPreferenceValue(requiredDataLabelsPrefKey(projectId), database),
    // #937: the whole posture, not one field — check 4 reports the level and source it read,
    // and reconstructing those from a single value would be the drift this file exists to avoid.
    posture: resolveRiskPosture(toPrefMap(await getAllPreferencesCached(database).catch(() => [])), projectId),
    requiredLabels,
    workers: await describeWorkers(fleet, providerName, requiredLabels, now),
    capacity: await resolveFleetCapacity(fleet, providerName, requiredLabels, now),
    now,
    sharesFilesystem: false,
  };
}

interface ChainRun {
  chain: PlacementCheckResult[];
  decidedBy: PlacementCheckId | null;
  predicted: PlacementOutcome;
}

/** Walk the chain in order, stopping at the first check that decides. */
async function runChain(ctx: EvalContext): Promise<ChainRun> {
  const chain: PlacementCheckResult[] = [];
  let decidedBy: PlacementCheckId | null = null;
  let predicted: PlacementOutcome = { kind: "host" };
  for (const spec of PLACEMENT_CHECK_CHAIN) {
    if (decidedBy) {
      chain.push(notReached(spec, ctx.projectId));
      continue;
    }
    const verdict = await EVALUATORS[spec.id](ctx);
    chain.push({
      id: spec.id,
      docStep: spec.docStep,
      title: spec.title,
      outcome: verdict.outcome,
      detail: verdict.detail,
      observed: verdict.observed ?? {},
      prefKeys: spec.prefKeys(ctx.projectId),
    });
    if (verdict.outcome !== "decided") continue;
    decidedBy = spec.id;
    predicted =
      ctx.strict && !verdict.neverRefuses
        ? {
            kind: "refused",
            message: `${verdict.refusalReason} and worker dispatch is strict for project ${ctx.projectId}`,
          }
        : { kind: "host" };
  }
  if (!decidedBy && ctx.workerId) predicted = { kind: "remote", workerId: ctx.workerId };
  return { chain, decidedBy, predicted };
}

export async function explainPlacement(params: {
  database?: Database;
  projectId: string;
  providerName: ProviderName;
  branch?: string;
  baseBranch?: string;
  branchSource?: BranchSource;
  now?: string;
}): Promise<PlacementExplanation> {
  const database = params.database ?? realDb;
  const { projectId, providerName, branch, baseBranch, now } = params;
  const ctx = await buildEvalContext({ ...params, database });
  const { chain, decidedBy, predicted } = await runChain(ctx);
  const actual = await dryRunResolver({ database, projectId, providerName, branch, baseBranch, now });
  return {
    projectId,
    provider: providerName,
    strict: ctx.strict,
    requiredLabels: ctx.requiredLabels,
    branchSource: ctx.branchSource,
    branch: branch ?? null,
    chain,
    decidedBy,
    predicted,
    actual,
    agreesWithResolver: actual.kind === predicted.kind,
    fleet: {
      registered: ctx.workers.length,
      online: ctx.workers.filter((w) => w.effectiveStatus === "online").length,
      connected: ctx.workers.filter((w) => w.connected).length,
      eligible: ctx.capacity.eligibleWorkers,
      freeSlots: ctx.capacity.freeSlots,
      provider: providerName,
      requiredLabels: ctx.requiredLabels,
      workers: ctx.workers,
      boardWorkerVersion: resolveOwnPackageVersion() ?? null,
    },
    summary: summarize(decidedBy, predicted, chain),
  };
}

/* ------------------------------------------------------------------ *
 * Per-session placement: which machine ACTUALLY ran it.
 * `sessions.workerId` has been written since epic #1 but no route, CLI or panel
 * ever read it, so "where did this run" was unanswerable after the fact.
 * ------------------------------------------------------------------ */


export async function listSessionPlacements(
  opts: {
    database?: Database;
    projectId?: string;
    workspaceId?: string;
    issueId?: string;
    workerId?: string;
    /** Only sessions that ran remotely. */
    remoteOnly?: boolean;
    limit?: number;
  } = {},
): Promise<SessionPlacementRecord[]> {
  const database = opts.database ?? realDb;
  const rows = await listSessionPlacementRows(
    {
      projectId: opts.projectId,
      workspaceId: opts.workspaceId,
      issueId: opts.issueId,
      workerId: opts.workerId,
      limit: opts.limit,
    },
    database,
  );
  const filtered = opts.remoteOnly ? rows.filter((r) => r.workerId !== null) : rows;
  const names = await getWorkerNamesByIds(
    filtered.map((r) => r.workerId),
    database,
  );
  return filtered.map((r) => ({
    ...r,
    // #801: WHY, beside WHERE. Narrowed back to the id union here rather than in the
    // repository — the column is free text to SQLite, and a row written by an older build
    // (or hand-edited) must not silently claim to be a valid reason id.
    placementReason: isPlacementReasonId(r.placementReason) ? r.placementReason : null,
    placementDetail: isPlacementReasonId(r.placementReason) ? r.placementDetail : null,
    branch: r.branch ?? null,
    issueNumber: r.issueNumber ?? null,
    issueTitle: r.issueTitle ?? null,
    endedAt: r.endedAt ?? null,
    placement: r.workerId ? "remote" : "host",
    workerId: r.workerId ?? null,
    workerName: r.workerId ? (names.get(r.workerId) ?? null) : null,
  }));
}

/* ------------------------------------------------------------------ *
 * The operator's actual question: "why was #N not dispatched?"
 * ------------------------------------------------------------------ */


/**
 * The branch matters — check 4 turns on it — so use the issue's REAL workspace when
 * it has one, and SAY SO when the branch a new workspace would get had to be
 * assumed. Silently assuming it would make check 4 report a pass the launch might
 * not get.
 */
function branchForIssue(
  issueNumber: number,
  ws: { branch: string; isDirect: boolean } | null,
): { branch: string | undefined; branchSource: BranchSource } {
  if (!ws) return { branch: `feature/${issueNumber}-placeholder`, branchSource: "assumed-feature-branch" };
  if (ws.isDirect) return { branch: undefined, branchSource: "none" };
  return { branch: ws.branch, branchSource: "workspace" };
}

export async function explainIssuePlacement(opts: {
  database?: Database;
  projectId: string;
  issueNumber: number;
  /** Override the provider; by default the one this project's next launch would use. */
  providerName?: ProviderName;
  now?: string;
}): Promise<IssuePlacementReport | { error: string }> {
  const database = opts.database ?? realDb;
  const issue = await getIssueIdentityByNumber(opts.projectId, opts.issueNumber, database);
  if (!issue) return { error: `issue #${opts.issueNumber} not found in project ${opts.projectId}` };

  const ws = await getLatestWorkspaceBranchForIssue(issue.id, database);
  const { branch, branchSource } = branchForIssue(issue.issueNumber, ws);
  const providerName =
    opts.providerName ??
    ((await loadProjectRuntimeConfig(database, { projectId: opts.projectId })).provider.provider as ProviderName);

  return {
    issue,
    explanation: await explainPlacement({
      database,
      projectId: opts.projectId,
      providerName,
      branch,
      baseBranch: ws?.baseBranch ?? undefined,
      branchSource,
      now: opts.now,
    }),
    sessions: await listSessionPlacements({ database, issueId: issue.id, limit: 20 }),
  };
}
