// Worker-fleet facade (epic #1, phase 1c #5): one shared bundle per database of
// the registry (auth + rows), the connection manager (live sockets) and the
// remote execution service — so the REST routes, the WS route and the session
// lifecycle all see the SAME fleet state in one board process.
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";

import { db as realDb } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getPreferenceValue } from "../repositories/session-lifecycle.repository.js";
import { WorkerDispatchUnavailableError as DispatchUnavailable, type Placement } from "./agent-dispatch.service.js";
import { createRemoteAgentService } from "./agent-remote.service.js";
import type { AgentExecutionService } from "./agent-dispatch.service.js";
import { createWorkerConnectionManager, type WorkerConnectionManager } from "./worker-connection.service.js";
import { revokeGitTokensForWorker } from "./git-http.service.js";
import { getWorkerRegistry, type WorkerRegistry } from "./worker-registry.service.js";
import type { ProviderName } from "./agent-provider.js";
import { getProjectById } from "../repositories/project.repository.js";
// Canonical home is the dependency-free protocol module, so the worker CLI can
// name the label without importing this service's graph. Re-exported here for
// existing importers.
import { SHARES_FILESYSTEM_LABEL } from "@agentic-kanban/shared/lib/worker-protocol";
import {
  allowedProfilesPrefKey,
  remoteDispatchBlockedByAllowlist,
} from "@agentic-kanban/shared/lib/profile-allowlist";
import {
  releaseWorkerSlot,
  reserveWorkerSlot,
  reservedSlotCount,
} from "./worker-slot-reservation.service.js";
import { remoteDispatchBlockedByRepoShape } from "./worker-transport-support.service.js";
import { recordWorkerEvent } from "./worker-events.service.js";
import type { PlacementReason, PlacementReasonId } from "../lib/placement-explain.types.js";
import { resolveResumeWorkerAffinity } from "./worker-resume-affinity.service.js";
export { SHARES_FILESYSTEM_LABEL };

// Strict-mode refusal. Defined in the dispatch layer (which must throw it when it
// refuses a host fallback, #245) and re-exported here for existing importers.
export { WorkerDispatchUnavailableError } from "./agent-dispatch.service.js";

export interface WorkerFleet {
  registry: WorkerRegistry;
  connections: WorkerConnectionManager;
  remoteAgentService: AgentExecutionService;
}

const fleetByDb = new WeakMap<object, WorkerFleet>();

export function getWorkerFleet(database: Database = realDb): WorkerFleet {
  let fleet = fleetByDb.get(database as object);
  if (!fleet) {
    const registry = getWorkerRegistry(database);
    const connections = createWorkerConnectionManager(registry);
    // The socket half of revocation lives in the connection manager itself; the
    // git-transport credential is this layer's business (#247).
    registry.onRevoke(async (workerId) => {
      // #775: pass the fleet's database — token scopes are persisted now, and revocation has
      // to reach the rows even when this process never started the git listener.
      await revokeGitTokensForWorker(workerId, database).catch((err) =>
        console.error(`[worker-fleet] could not revoke git tokens for worker ${workerId}`, err),
      );
    });
    // #801 — the WebSocket lifecycle, made durable. Wired HERE and not in
    // `fleet-listener.service.ts` (which the ticket named) because the listener is only
    // ONE of the two ways a worker connects: a same-machine worker dials the board's main
    // port, whose WS route is built from this same manager. Subscribing at the composition
    // root is the only place that sees both, and it is also the only place that holds the
    // `database` the event write needs.
    //
    // "In what order did that worker connect, take work and go away?" is the #699/#706
    // question, and a connect/disconnect pair is the spine of the answer. Fire-and-forget
    // by contract (`recordWorkerEvent` never throws), so a diagnostic can never break a
    // socket callback.
    connections.onConnect((workerId) => {
      void recordWorkerEvent({
        database,
        workerId,
        type: "connected",
        summary: "worker opened a board WebSocket",
      });
    });
    connections.onDisconnect((workerId) => {
      void recordWorkerEvent({
        database,
        workerId,
        type: "disconnected",
        summary: "worker's board WebSocket closed",
      });
    });
    fleet = {
      registry,
      connections,
      remoteAgentService: createRemoteAgentService(connections, database),
    };
    fleetByDb.set(database as object, fleet);
  }
  return fleet;
}

// #496: built from the registry, so an unregistered prefix is a COMPILE error.
const workerDispatchPrefDef = projectPref("worker_dispatch");
const workerLabelsPrefDef = projectPref("worker_labels");
const workerStrictPrefDef = projectPref("worker_dispatch_strict");

export function workerDispatchPrefKey(projectId: string): string {
  return workerDispatchPrefDef.key(projectId);
}

/** CSV of labels a worker must carry to run this project's work (e.g. "docker,linux"). */
export function workerLabelsPrefKey(projectId: string): string {
  return workerLabelsPrefDef.key(projectId);
}

/**
 * When "true", the project REFUSES to fall back to the board host: with no
 * eligible worker the monitor skips the start (reason `no_available_worker`)
 * instead of running the agent locally. Mirrors devcontainer_strict.
 */
export function workerStrictPrefKey(projectId: string): string {
  return workerStrictPrefDef.key(projectId);
}

export function parseRequiredLabels(pref: string | undefined): string[] {
  return (pref ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export interface FleetCapacity {
  /** Workers connected, online and matching the filters. */
  eligibleWorkers: number;
  /** Sum of their remaining concurrency — how many more sessions the fleet can take. */
  freeSlots: number;
}

/** Aggregate free capacity for a provider + label requirement. */
export async function resolveFleetCapacity(
  fleet: WorkerFleet,
  providerName: ProviderName,
  requiredLabels: string[] = [],
  now?: string,
): Promise<FleetCapacity> {
  const candidates = await eligibleWorkers(fleet, providerName, requiredLabels, now);
  return {
    eligibleWorkers: candidates.length,
    freeSlots: candidates.reduce((sum, w) => sum + Math.max(0, w.cap - w.load), 0),
  };
}

function parseLabels(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === "string") : [];
  } catch {
    return [];
  }
}

export async function workerSharesFilesystem(fleet: WorkerFleet, workerId: string, now?: string): Promise<boolean> {
  const worker = (await fleet.registry.listWorkersView(now)).find((w) => w.id === workerId);
  return parseLabels(worker?.labels ?? null).includes(SHARES_FILESYSTEM_LABEL);
}

/**
 * Pick the worker for a new launch: connected + effectively online (not
 * draining), provider available (an empty/absent provider list means "any"),
 * free capacity — least-loaded first. Empty = no eligible worker.
 *
 * SPLIT INTO AN AWAIT AND A SYNCHRONOUS FILTER on purpose (#751). The reservation
 * that makes concurrent selection safe has to be taken in the same synchronous turn
 * as the load read it is based on, and an `async` helper cannot offer that: its
 * return crosses a microtask boundary, so two callers both read "free" before either
 * reserves. That was the actual defect — a reservation placed after this function
 * returned would have looked correct and fixed nothing.
 */
type WorkerCandidate = { id: string; load: number; cap: number };

function filterEligibleWorkers(
  fleet: WorkerFleet,
  workers: Awaited<ReturnType<WorkerRegistry["listWorkersView"]>>,
  providerName: ProviderName,
  requiredLabels: string[],
  nowMs?: number,
): WorkerCandidate[] {
  return workers
    .filter((w) => w.effectiveStatus === "online")
    .filter((w) => fleet.connections.isConnected(w.id))
    .filter((w) => {
      if (!w.providers) return true;
      try {
        const list = JSON.parse(w.providers) as string[];
        return list.length === 0 || list.includes(providerName);
      } catch {
        return true;
      }
    })
    .filter((w) => {
      if (requiredLabels.length === 0) return true;
      const labels = parseLabels(w.labels);
      return requiredLabels.every((required) => labels.includes(required));
    })
    // Load counts DISPATCHED work, not just work that has already spoken (#248) —
    // and, since #751, work that has been PLACED but not yet dispatched. For a
    // true-remote placement the `assign` is sent from an async continuation, so
    // "dispatched" is not the same instant as "decided": without the reservations a
    // second concurrent placement reads this worker as free and both land on it.
    .map((w) => {
      const assigned = fleet.connections.assignedSessionIds(w.id, nowMs);
      return {
        id: w.id,
        load: assigned.length + reservedSlotCount(w.id, assigned, nowMs),
        cap: w.maxConcurrency,
      };
    })
    .filter((w) => w.load < w.cap)
    .sort((a, b) => a.load - b.load);
}

async function eligibleWorkers(
  fleet: WorkerFleet,
  providerName: ProviderName,
  requiredLabels: string[],
  now?: string,
  nowMs?: number,
): Promise<WorkerCandidate[]> {
  const workers = await fleet.registry.listWorkersView(now);
  return filterEligibleWorkers(fleet, workers, providerName, requiredLabels, nowMs);
}

export async function selectWorkerForLaunch(
  fleet: WorkerFleet,
  providerName: ProviderName,
  requiredLabels: string[] = [],
  now?: string,
): Promise<string | null> {
  const candidates = await eligibleWorkers(fleet, providerName, requiredLabels, now);
  return candidates[0]?.id ?? null;
}

/**
 * Pick a worker AND claim its slot atomically (#751).
 *
 * `selectWorkerForLaunch` answers a question; this one takes an action, and the
 * difference is the whole fix. The registry read is awaited FIRST and everything
 * after it — filtering, the load read, the reservation — runs in one synchronous
 * turn, so two concurrent callers cannot both come back with the last free slot on
 * the same worker: whichever resumes second filters against a load that already
 * includes the first one's reservation.
 *
 * The caller MUST either hand the `reservationId` to the placement (so the launch
 * claims it) or `releaseWorkerSlot` it — a reservation nobody claims pins capacity
 * until its TTL.
 */
export async function selectAndReserveWorkerForLaunch(
  fleet: WorkerFleet,
  providerName: ProviderName,
  requiredLabels: string[] = [],
  now?: string,
  nowMs?: number,
  /**
   * Resume affinity (#750): the worker that holds this session's transcript and checkout.
   * A PREFERENCE over the least-loaded default, applied to the already-filtered candidate
   * list — so a holder with no free slot cannot be over-assigned, it is simply not there.
   */
  preferWorkerId?: string,
): Promise<{ workerId: string; reservationId: string; honouredAffinity?: boolean } | null> {
  const workers = await fleet.registry.listWorkersView(now);
  // --- no `await` past this line, or the reservation proves nothing ---
  const candidates = filterEligibleWorkers(fleet, workers, providerName, requiredLabels, nowMs);
  const preferred = preferWorkerId ? candidates.find((c) => c.id === preferWorkerId) : undefined;
  const chosen = preferred ?? candidates[0];
  if (!chosen) return null;
  return {
    workerId: chosen.id,
    reservationId: reserveWorkerSlot(chosen.id, nowMs),
    ...(preferWorkerId ? { honouredAffinity: chosen.id === preferWorkerId } : {}),
  };
}

/**
 * Placement policy for a builder launch (generalizes the devcontainer
 * provision decision): remote only when the project opted in via
 * `worker_dispatch_<projectId>` AND an eligible worker is available; anything
 * else degrades loudly to host — never blocks a launch.
 */
export async function resolveWorkerPlacement(params: {
  database: Database;
  projectId: string;
  providerName: ProviderName;
  /** Workspace branch info — required to give a true remote worker git transport. */
  branch?: string;
  baseBranch?: string;
  /**
   * Set when this launch RESUMES a provider session (#750). The transcript and the
   * checkout both live on the worker that ran it, so placement prefers that worker over
   * the least-loaded one. Omitted for a fresh session, where there is nothing to be near.
   */
  resumeProviderSessionId?: string;
  now?: string;
  nowMs?: number;
}): Promise<Placement> {
  // #751: a remote decision claims a capacity slot, and EVERY exit from this
  // function that is not a remote placement has to give it back — including the
  // strict refusal, which leaves by throwing. Doing that at one seam (here) rather
  // than at each of the five `return { kind: "host" }` sites is the point: the
  // failure mode of a missed release is a worker that silently loses a slot until
  // the TTL expires, which is invisible in exactly the way #751 was.
  const reservation: { id?: string } = {};
  try {
    const placement = await resolvePlacementWithReservation(params, reservation);
    if (placement.kind !== "remote") releaseWorkerSlot(reservation.id);
    return placement;
  } catch (err) {
    releaseWorkerSlot(reservation.id);
    throw err;
  }
}

/**
 * #801 — the recording seam the placement explanation could never have.
 *
 * `explainPlacement` re-derives the chain against LIVE state, which answers "why is this not
 * dispatching now" and cannot answer "why did that session run on the host last Tuesday":
 * the prefs, the fleet and the repo shape have all moved. So the deciding step is stamped
 * onto the decision HERE, where it is actually made, and the caller persists it on the
 * session row. The ids are the same `PlacementCheckId`s the explanation uses, deliberately —
 * a historical record and a live explanation that disagreed on vocabulary would be two
 * answers to one question.
 */
function because(id: PlacementReasonId, detail: string): PlacementReason {
  return { id, detail };
}

function hostBecause(id: PlacementReasonId, detail: string): Placement {
  return { kind: "host", reason: because(id, detail) };
}

async function resolvePlacementWithReservation(
  params: Parameters<typeof resolveWorkerPlacement>[0],
  reservation: { id?: string },
): Promise<Placement> {
  const { database, projectId, providerName, branch, baseBranch, resumeProviderSessionId, now, nowMs } = params;
  try {
    const pref = await getPreferenceValue(workerDispatchPrefKey(projectId), database);
    if (pref !== "true") {
      return hostBecause("dispatch_opt_in", `worker_dispatch is not enabled for project ${projectId}`);
    }
    const fleet = getWorkerFleet(database);
    // Read strictness ONCE and carry it on the placement (#245): every
    // host-fallback path below — and the dispatch proxy's own catch, which runs
    // long after this function returned — must honour the same answer.
    const strict = (await getPreferenceValue(workerStrictPrefKey(projectId), database)) === "true";
    const refuseHost = (reason: string): never => {
      throw new DispatchUnavailable(`${reason} and worker dispatch is strict for project ${projectId}`);
    };
    // #651: a restricted project does not go remote. Checked BEFORE worker selection —
    // the answer does not depend on which worker is free, and refusing early keeps a
    // strict project's message about the restriction rather than about capacity.
    const allowlistBlock = remoteDispatchBlockedByAllowlist(
      await getPreferenceValue(allowedProfilesPrefKey(projectId), database),
    );
    if (allowlistBlock.blocked) {
      if (strict) refuseHost(`project ${projectId} cannot dispatch remotely: ${allowlistBlock.reason}`);
      console.warn(
        `[worker-fleet] project ${projectId} wants worker dispatch but ${allowlistBlock.reason}; launching on host`,
      );
      return hostBecause("profile_allowlist", allowlistBlock.reason);
    }
    const requiredLabels = parseRequiredLabels(await getPreferenceValue(workerLabelsPrefKey(projectId), database));
    // #751: select AND reserve atomically. Reading the load and then reserving after
    // another `await` would leave the same window this fixes.
    // #750: a resume follows its own state. Resolved BEFORE the selection because the
    // selection's reservation must be taken in one synchronous turn (see #751) — an await
    // between the load read and the reserve would undo that.
    const preferWorkerId =
      resumeProviderSessionId && branch
        ? (await resolveResumeWorkerAffinity({ projectId, branch }, database)) ?? undefined
        : undefined;
    const placed = await selectAndReserveWorkerForLaunch(
      fleet, providerName, requiredLabels, now, nowMs, preferWorkerId,
    );
    if (!placed) {
      const detail = requiredLabels.length > 0 ? ` with labels [${requiredLabels.join(",")}]` : "";
      if (strict) refuseHost(`no eligible ${providerName} worker${detail}`);
      console.warn(
        `[worker-fleet] project ${projectId} wants worker dispatch but no eligible ${providerName} worker${detail} is available; launching on host`,
      );
      return hostBecause("eligible_worker", `no eligible ${providerName} worker${detail} is available`);
    }
    const { workerId } = placed;
    reservation.id = placed.reservationId;
    if (preferWorkerId && placed.honouredAffinity === false) {
      // Said out loud: the resume names a provider session whose transcript is on ANOTHER
      // machine, so it will most likely fail there with "no conversation found" — which
      // arrives as a launch failure and explains nothing on its own.
      console.warn(
        `[worker-fleet] resume of ${branch ?? "(no branch)"} wanted worker ${preferWorkerId} ` +
          `(it holds the provider transcript and the checkout) but that worker has no free ` +
          `slot; placing on ${workerId} instead — the resume may fail with "no conversation found"`,
      );
    }
    if (await workerSharesFilesystem(fleet, workerId, now)) {
      return {
        kind: "remote",
        workerId,
        strict,
        reservationId: reservation.id,
        reason: because("eligible_worker", `worker ${workerId} shares this filesystem — no git transport needed`),
      };
    }

    // True remote worker: it needs the repo over git transport. Without a
    // branch to push back (e.g. a direct workspace with no feature branch)
    // there is nothing safe to dispatch remotely — stay on the host, unless the
    // project forbids that.
    if (!branch) {
      if (strict) refuseHost(`remote worker ${workerId} needs a branch for git transport`);
      console.warn(`[worker-fleet] remote worker ${workerId} needs a branch for git transport; launching on host`);
      return hostBecause("branch_for_transport", `remote worker ${workerId} needs a branch for git transport`);
    }
    const project = await getProjectById(projectId, database);
    if (!project?.repoPath) {
      if (strict) refuseHost(`project ${projectId} has no repoPath to serve over git transport`);
      console.warn(`[worker-fleet] project ${projectId} has no repoPath; launching on host`);
      return hostBecause("project_repo_path", `project ${projectId} has no repoPath to serve over git transport`);
    }
    // #748: the git transport carries ONE repository, without LFS and without
    // submodules. A project that needs more than that was dispatched anyway — the
    // worker built against an incomplete checkout and returned a result that looked
    // legitimate. So refuse, exactly as #651 refuses a profile-allowlisted project:
    // the board cannot serve this shape remotely, so it does not go remote.
    //
    // Asked HERE and not beside the allowlist because a filesystem-sharing worker
    // needs no transport at all — it reads the board's own worktrees, siblings and
    // LFS objects included — and that branch has already returned above.
    const repoShape = await remoteDispatchBlockedByRepoShape({
      projectId,
      repoPath: project.repoPath,
      database,
    });
    if (repoShape.blocked) {
      if (strict) refuseHost(`project ${projectId} cannot dispatch remotely: ${repoShape.reason}`);
      console.warn(
        `[worker-fleet] project ${projectId} wants worker dispatch but ${repoShape.reason}; launching on host`,
      );
      return hostBecause("repo_transport_shape", repoShape.reason);
    }
    return {
      kind: "remote",
      workerId,
      strict,
      reservationId: reservation.id,
      reason: because("eligible_worker", `worker ${workerId} took it over git transport on ${branch}`),
      repo: {
        projectId,
        repoPath: project.repoPath,
        branch,
        baseBranch: baseBranch || project.defaultBranch || "master",
        setupScript: project.setupScript ?? undefined,
      },
    };
  } catch (err) {
    // Strict mode is a deliberate refusal, not a resolution failure — propagate it
    // so the caller surfaces "no worker" instead of silently running on the host.
    if (err instanceof DispatchUnavailable) throw err;
    console.error(`[worker-fleet] placement resolution failed; launching on host`, err);
    return hostBecause("resolver_error", `placement resolution threw: ${String(err)}`);
  }
}

/**
 * Would this project's next launch find a worker? Used by the monitor to skip a
 * start (reason `no_available_worker`) instead of queuing work that strict-mode
 * placement would refuse. Non-strict projects always report available (they can
 * fall back to the host).
 */
export async function projectCanDispatch(params: {
  database: Database;
  projectId: string;
  providerName: ProviderName;
  now?: string;
}): Promise<{ available: true } | { available: false; reason: string }> {
  const { database, projectId, providerName, now } = params;
  try {
    if ((await getPreferenceValue(workerDispatchPrefKey(projectId), database)) !== "true") return { available: true };
    if ((await getPreferenceValue(workerStrictPrefKey(projectId), database)) !== "true") return { available: true };
    // #651: same refusal the placement makes, surfaced one step earlier so the monitor
    // skips the start with the real reason instead of starting and then failing.
    const allowlistBlock = remoteDispatchBlockedByAllowlist(
      await getPreferenceValue(allowedProfilesPrefKey(projectId), database),
    );
    if (allowlistBlock.blocked) return { available: false, reason: allowlistBlock.reason };
    const fleet = getWorkerFleet(database);
    const requiredLabels = parseRequiredLabels(await getPreferenceValue(workerLabelsPrefKey(projectId), database));
    // #748: same refusal the placement makes, one step earlier, so the monitor skips
    // the start with the REAL reason instead of starting and then falling back. Only
    // when no eligible worker shares the board's filesystem: such a worker needs no
    // git transport, so the repo shape does not constrain it.
    const eligible = await eligibleWorkers(fleet, providerName, requiredLabels, now);
    const sharing = await Promise.all(eligible.map((w) => workerSharesFilesystem(fleet, w.id, now)));
    if (eligible.length > 0 && !sharing.some(Boolean)) {
      const project = await getProjectById(projectId, database);
      if (project?.repoPath) {
        const repoShape = await remoteDispatchBlockedByRepoShape({
          projectId,
          repoPath: project.repoPath,
          database,
        });
        if (repoShape.blocked) return { available: false, reason: repoShape.reason };
      }
    }
    const capacity = await resolveFleetCapacity(fleet, providerName, requiredLabels, now);
    if (capacity.freeSlots > 0) return { available: true };
    const detail = requiredLabels.length > 0 ? ` matching [${requiredLabels.join(",")}]` : "";
    return { available: false, reason: `no fleet worker${detail} has free capacity` };
  } catch (err) {
    console.error(`[worker-fleet] dispatch availability check failed; treating as available`, err);
    return { available: true };
  }
}
