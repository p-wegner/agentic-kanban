// WHERE a launch runs, and the record of why (#938 extracted this from
// `session-lifecycle.ts`, which was at the god-module gate's 1000-line ceiling).
//
// One cohesive job: turn a workspace about to launch into a `Placement`, translate the
// resolver's strict-mode refusal into the `WorkspaceError` shape callers already handle,
// and stamp the deciding reason onto the session row. `startSession` keeps the launch; this
// keeps the placement.
import type { Database } from "../../db/index.js";
import type { Placement } from "../agent-dispatch.service.js";
import type { ProviderName } from "../agent-provider.js";
import { resolveWorkerPlacement, WorkerDispatchUnavailableError } from "../worker-fleet.service.js";
import { resolveResumeWorkerAffinity, resumeConversationReachable, withResumeHandoff } from "../worker-resume-affinity.service.js";
import { getNewestSessionWorkerForBranch } from "../../repositories/worker.repository.js";
import { countRunningHostSessions, updateSessionPlacementReason } from "../../repositories/placement-observability.repository.js";
import { readTier0Capacity, toWorkerCapacitySnapshot } from "@agentic-kanban/shared/lib/machine-capacity";
import { WorkspaceError } from "../workspace-internals.js";

// #1347: the strict-dispatch hold runs just before placement; re-exported so the lifecycle imports one module.
import { awaitStrictLaunchWorker } from "./strict-launch-hold.js";
export { awaitStrictLaunchWorker };

/**
 * #801 — the recording seam for "why did THAT session run on the host".
 *
 * `resolveWorkerPlacement` stamps its deciding check onto the placement it returns; this is
 * where that becomes durable. A live re-derivation can never answer the historical question,
 * because the preferences, the fleet and the repo shape have all moved since.
 *
 * Written only for a RESOLVED placement: an explicit `placement` argument was never
 * resolved, so it carries no reasoning, and stamping a fabricated one would destroy the
 * distinction the nullable column exists to keep. Best-effort and un-awaited, exactly like
 * the containerId write — an observability record must never be able to fail a launch.
 */
export function recordPlacementReason(
  sessionId: string,
  placement: Placement | undefined,
  database: Database,
): void {
  const reason = placement?.reason;
  if (!reason) return;
  updateSessionPlacementReason(sessionId, reason, database).catch((err) =>
    console.error(`[session] Failed to store session placement reason: sessionId=${sessionId}`, err),
  );
}

/**
 * Resolve where this launch runs, and record why (epic #1, #184, #801, #908, #938).
 *
 * A project opted into worker dispatch gets an eligible remote worker, else the host.
 * Strict worker dispatch refuses the host fallback: surfaced as a CONFLICT the caller can
 * act on — the same shape devcontainer strict mode uses for `ISOLATION_REFUSED` — rather
 * than silently running on the board.
 */
export async function resolveSessionPlacement(args: {
  database: Database;
  sessionId: string;
  projectId: string;
  providerName: ProviderName;
  /** A direct workspace has no feature branch to push back, so it has no git transport. */
  branch?: string;
  baseBranch?: string;
  /** #750: set only when this launch actually resumes a provider session. */
  resumeProviderSessionId?: string;
  /** #1432: extra worker labels this launch needs (a devcontainer builder needs `docker`). */
  extraRequiredLabels?: string[];
}): Promise<Placement> {
  const { database, sessionId, projectId, providerName, branch, baseBranch, resumeProviderSessionId, extraRequiredLabels } = args;
  // #908/#938: ONE Tier-0 read feeding BOTH placement inputs — reading it twice would let
  // them disagree about the same instant. Tier 0 is one in-process `os.freemem()` call,
  // cheap enough per launch (Tier 1 spawns a process and is the monitor's per-cycle read).
  const hostTier0 = readTier0Capacity();
  const placement = await resolveWorkerPlacement({
    database,
    projectId,
    providerName,
    branch,
    baseBranch,
    resumeProviderSessionId,
    extraRequiredLabels,
    // #908: a saturated host does NOT block this launch — that would turn a placement input
    // into a gate. It only changes which reason lands on the session record when the chain
    // picks a worker anyway (`machine_saturated` rather than `eligible_worker`).
    hostSaturated: hostTier0.hold,
    // #938: the same reading in the shape a worker heartbeats, so the board is RANKED
    // against the fleet instead of only fallen back to. Tier 0 is RAM-only, so its
    // `thrashing: "none"` is honestly "not measured" — the host can only win on free RAM it
    // actually reported, never on a thrashing tiebreak it has not earned.
    hostCapacity: toWorkerCapacitySnapshot(hostTier0),
    // #1380: the load `host_builder_slots` caps — builders and reviewers alike, this session excluded.
    hostActiveSessions: await countRunningHostSessions(sessionId, database).catch(() => undefined),
  }).catch((err) => {
    if (err instanceof WorkerDispatchUnavailableError) {
      throw new WorkspaceError(err.message, "CONFLICT", { code: "NO_AVAILABLE_WORKER" });
    }
    throw err;
  });
  recordPlacementReason(sessionId, placement, database);
  return placement;
}

/**
 * #1459: can a `--resume` launched on this placement find its conversation? Looks up the worker
 * that ran the branch last (null = the host, also what an unreadable lookup yields) and compares.
 */
export async function resumeReachableFromPlacement(
  database: Database,
  projectId: string,
  workspace: { isDirect?: boolean | null; branch: string },
  placement: Placement,
): Promise<boolean> {
  let holder: string | null = null;
  if (!workspace.isDirect) {
    try {
      // Newest session wins, host sessions included: a host fallback after a worker run moved the conversation.
      const newest = await getNewestSessionWorkerForBranch(projectId, workspace.branch, database);
      holder = newest ? newest.workerId : await resolveResumeWorkerAffinity({ projectId, branch: workspace.branch }, database);
    } catch { holder = null; }
  }
  return resumeConversationReachable(holder, placement);
}

/**
 * #1459: keep `--resume` only where its conversation lives. Otherwise drop it and return a prompt
 * carrying HANDOFF.md (builders only, #853) so the fresh session continues the work.
 */
export async function resumeOrHandoff(args: {
  database: Database;
  projectId: string;
  workspace: { isDirect?: boolean | null; branch: string };
  placement: Placement;
  providerSessionId: string | undefined;
  prompt: string;
  /** Set for builder sessions only; where HANDOFF.md is read from. */
  workingDir: string | undefined;
  sessionId: string;
}): Promise<{ providerSessionId: string | undefined; prompt: string }> {
  const { providerSessionId } = args;
  if (!providerSessionId || (await resumeReachableFromPlacement(args.database, args.projectId, args.workspace, args.placement))) {
    return { providerSessionId, prompt: args.prompt };
  }
  console.warn(`[session] resume ${providerSessionId} not reachable from placement ${args.placement.kind}; starting fresh with handoff: sessionId=${args.sessionId}`);
  let handoff: string | null = null;
  if (args.workingDir) {
    try {
      handoff = (await (await import("../handoff.service.js")).readHandoffFile(args.workingDir)) || null;
    } catch { /* handoff not available — the ticket brief still travels */ }
  }
  return { providerSessionId: undefined, prompt: withResumeHandoff(args.prompt, handoff) };
}

/** #1434: how long a re-placement waits for a worker before the session fails, and how often it may re-place. */
export const REPLACE_QUEUE_TIMEOUT_MS = 30 * 60_000;
export const REPLACE_MAX_ATTEMPTS = 3;

/**
 * The `replacePlacement` hook for a self-placed launch: when a strict remote launch dies late
 * (auth-expired login, full worker), queue like #1411 until a worker is eligible, then place
 * again. Rejecting (nobody eligible within the bound) lets the proxy finalize the session.
 */
export function createReplacePlacement(args: {
  database: Database;
  workspaceId: string;
  sessionId: string;
  projectId: string;
  providerName: ProviderName;
  triggerType?: string | null;
  workspace: { isDirect?: boolean | null; branch: string; baseBranch?: string | null };
  /** Only a launch that placed itself is re-placed; an explicit placement or a container is not. */
  enabled: boolean;
  resumeProviderSessionId?: string;
}): (() => Promise<Placement>) | undefined {
  if (!args.enabled || !args.projectId) return undefined;
  const { database, workspaceId, sessionId, projectId, providerName, triggerType, workspace, resumeProviderSessionId } = args;
  let attempts = 0;
  return async () => {
    if (++attempts > REPLACE_MAX_ATTEMPTS) throw new Error(`re-placed ${REPLACE_MAX_ATTEMPTS} times already`);
    await awaitStrictLaunchWorker({ database, workspaceId, projectId, providerName, triggerType }, { queueTimeoutMs: REPLACE_QUEUE_TIMEOUT_MS });
    return resolveSessionPlacement({
      database, sessionId, projectId, providerName, resumeProviderSessionId,
      branch: workspace.isDirect ? undefined : workspace.branch,
      baseBranch: workspace.baseBranch ?? undefined,
    });
  };
}
