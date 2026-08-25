// Execution-placement seam for the worker-fleet architecture (#1, phase 0 #2).
//
// `agent.service.ts` runs agents as HOST subprocesses (optionally wrapped into a
// `docker exec` by container-wrap). A remote worker is a different EXECUTION
// SERVICE, not a different launch config — so the seam is an interface over the
// session-keyed surface the session lifecycle consumes, plus a dispatching proxy
// that picks an implementation per launch and remembers the choice for the
// follow-up calls (kill/sendInput/closeStdin/...) that arrive keyed by sessionId
// only. BOTH implementations exist today: `session-manager/session-lifecycle.ts`
// builds this proxy as `createAgentDispatch({ host: realAgentService, remote:
// getWorkerFleet().remoteAgentService })`, so a `remote` placement really does
// route to `agent-remote.service.ts` and out over a fleet worker's WebSocket.
// (This header used to say "today only the host implementation exists" and call
// the proxy a near-identity wrapper. That was true of phase 0 and stopped being
// true when phase 1c #5 landed — corrected in #756.)

import type { AgentOutputCallback } from "./agent.service.js";
import type { PlacementReason } from "../lib/placement-explain.types.js";
import type { ProviderId, ProviderName } from "./agent-provider.js";
import type { ContainerProvision } from "./devcontainer-workspace.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { claimWorkerSlot, releaseWorkerSlot } from "./worker-slot-reservation.service.js";

/**
 * Where a session's agent should execute. Carried through StartSessionOptions.
 * `remote` names a connected worker from the worker registry (phase 1a).
 *
 * `kind: "container"` is a DEAD arm: the fold never happened, so nothing in the
 * tree constructs or matches it and container placement still travels as the
 * separate `containerProvision` launch argument. The old comment here promised
 * the fold "in phase 1c", which is misleading in the direction that matters —
 * a reader looking for container placement would look in the wrong place.
 */
/**
 * Strict-mode refusal: dispatch was required but no worker could take the work.
 *
 * Lives here rather than in worker-fleet.service because the DISPATCH layer must
 * be able to refuse a host fallback (#245) without importing the fleet service
 * (which imports this module). Re-exported from worker-fleet.service for the
 * existing importers.
 */
export class WorkerDispatchUnavailableError extends Error {
  readonly code = "NO_AVAILABLE_WORKER";
  constructor(message: string) {
    super(message);
    this.name = "WorkerDispatchUnavailableError";
  }
}

export type Placement =
  /**
   * `reason` (#801) is the resolver's own verdict, carried on the decision so the caller can
   * PERSIST it. It is optional because an explicit placement — a test's, or a caller that
   * decided for itself — was never resolved and therefore has no reasoning to record; a
   * fabricated one would be worse than the null.
   */
  | { kind: "host"; reason?: PlacementReason }
  | { kind: "container"; reason?: PlacementReason }
  | {
      kind: "remote";
      workerId: string;
      reason?: PlacementReason;
      /**
       * The project set `worker_dispatch_strict_<projectId>` — host execution is
       * FORBIDDEN for this session (#245). Carried on the placement because
       * strictness was previously honoured only while CHOOSING a worker: if the
       * worker dropped its socket in the window before `assign`, the dispatch
       * proxy caught the throw and silently ran the agent on the board host,
       * which is exactly what strict mode exists to prevent.
       */
      strict?: boolean;
      /**
       * Capacity slot claimed for this decision (#751), to be released when the
       * decision is abandoned and claimed by the session when it is honoured.
       *
       * Fleet load is otherwise counted from the moment the `assign` goes on the
       * wire, which for a git-transport dispatch is an async continuation away from
       * the placement — so two concurrent placements read the same worker as free.
       * The reservation makes the DECISION the thing that occupies the slot, which
       * is the only point at which the choice is actually made.
       */
      reservationId?: string;
      /**
       * Git transport for a TRUE remote worker (phase 2): the worker clones the
       * project from the board and pushes results back. Absent = same-machine
       * dispatch, where the worker shares the board's filesystem (phase 1c).
       */
      repo?: {
        projectId: string;
        repoPath: string;
        branch: string;
        baseBranch: string;
        setupScript?: string;
      };
    };

/**
 * Opaque handle to a launched agent. A host launch returns a real ChildProcess
 * (which satisfies this shape); a remote launch has no local process, only an
 * optional pid on the worker's machine. Callers must not assume more than this.
 */
export interface AgentHandle {
  readonly pid?: number;
}

/**
 * The session-keyed execution surface the session lifecycle depends on —
 * extracted from `typeof agent.service` so an alternative implementation
 * (remote worker) can be substituted per session. The real agent.service
 * module satisfies this structurally.
 */
/**
 * Everything a launch needs, as ONE object (#524).
 *
 * This was twenty POSITIONAL parameters, re-typed in three places and relayed
 * positionally three more — so every new knob (six so far: skipPermissions, model,
 * contextFiles, systemInstructions, containerProvision, placement) meant appending an
 * argument at six sites in the right order. Two adjacent optionals of the same type
 * transpose silently; with named fields that becomes a compile error, and a field an
 * implementation forgets to read is visible rather than being "argument 17".
 */
export interface AgentLaunchRequest {
  worktreePath: string;
  sessionId: string;
  prompt: string;
  agentArgs: string | undefined;
  onOutput: AgentOutputCallback;
  providerSessionId?: string;
  agentCommand?: string;
  keepAlive?: boolean;
  permissionPromptTool?: string;
  planMode?: boolean;
  provider?: ProviderId;
  profile?: { provider: ProviderName; name: string };
  extraEnv?: Record<string, string>;
  skipPermissions?: boolean;
  model?: string;
  contextFiles?: string[];
  systemInstructions?: string;
  /**
   * When present the agent runs INSIDE this provisioned devcontainer instead of on the
   * host. Provisioning is async and happens in the caller; launching stays synchronous.
   */
  containerProvision?: ContainerProvision;
  placement?: Placement;
  /**
   * Set by the dispatch proxy; implemented by the proxy, called by a NON-HOST
   * implementation (#751).
   *
   * The host-fallback / strict contract below is written against a THROWN `launch`.
   * A git-transport remote launch cannot throw: its prerequisites (the git-http
   * listener, the skill payload, the scoped token) resolve after `launch` has
   * already returned, so a worker that vanished in that window — or answered
   * `assign_failed` — used to become a synthesized `exit 1` on the session. That is
   * the same bug class #245 fixed for the synchronous path: a non-strict project got
   * a failed session instead of a host run, and a strict project got a failure whose
   * reason said nothing about dispatch.
   *
   * So the strictness lives on the DECISION and the proxy owns both paths. An
   * implementation that discovers a LAUNCH failure late reports it here instead of
   * synthesizing an exit, and the proxy applies the identical rule: host fallback,
   * or a refusal that names itself as one.
   */
  onDeferredLaunchFailure?: (failure: DeferredLaunchFailure) => void;
}

/**
 * A launch that failed AFTER `launch` returned — reported through
 * `AgentLaunchRequest.onDeferredLaunchFailure`.
 *
 * `kind` exists so the proxy can tell "nobody took this" from "someone took it and
 * the launch died there", which is the distinction `assign_failed` used to erase by
 * arriving as a plain `exit 1` (#751). It is also what makes a capacity refusal
 * re-placeable in principle: it is the one kind where another worker would have
 * succeeded.
 */
export interface DeferredLaunchFailure {
  kind:
    /** The assign could not be delivered (worker gone between placement and send). */
    | "dispatch"
    /** The worker refused: already at maxConcurrency. Another worker could take it. */
    | "capacity"
    /** The worker took it but could not build a runnable checkout (clone/setup/LFS). */
    | "provisioning"
    /** The worker disappeared and did not come back within the grace window. */
    | "worker-lost";
  reason: string;
}

/**
 * Prefix of the stderr line the dispatch proxy synthesizes when it cannot place a
 * session anywhere. Exported so the exit classifier can recognise a LAUNCH failure
 * (which belongs on the launch-failure surfaces and the auth-rotation ring) rather
 * than reading it as a model that ran and exited non-zero.
 */
export const DISPATCH_LAUNCH_FAILURE_PREFIX = "[dispatch:launch-failed]";

export interface AgentExecutionService {
  launch(request: AgentLaunchRequest): AgentHandle;
  kill(sessionId: string): boolean;
  sendInput(sessionId: string, content: string): boolean;
  closeStdin(sessionId: string): boolean;
  isStdinOpen(sessionId: string): boolean;
  getProcess(sessionId: string): AgentHandle | undefined;
  getPid(sessionId: string): number | undefined;
  isPidAlive(sessionId: string): boolean;
  /**
   * Does THIS implementation hold `sessionId` right now?
   *
   * Optional, because only an implementation that can acquire a session OUTSIDE
   * `launch` needs it — and exactly one can: the remote service ADOPTS sessions on
   * boot that a previous board process launched (#745). Nothing told the dispatch
   * proxy about those, so `forSession` fell through to the host for every one of
   * them and the host, which has never heard of the session, answered `isPidAlive`
   * false. That is #874's false "Agent process has exited" about an agent still
   * running on a worker — the same failure shape the `kill()` comment below records
   * having already been fixed once, arriving through a different door.
   */
  tracksSession?(sessionId: string): boolean;
  /**
   * Where is this session executing? Answered by the dispatch proxy; an individual
   * implementation has no reason to implement it. `undefined` means "no record" and
   * is never a claim that the session is gone.
   */
  placementOf?(sessionId: string): "host" | "remote" | undefined;
}

export interface AgentDispatchImplementations {
  host: AgentExecutionService;
  /**
   * The fleet's remote execution service. Registered by `session-lifecycle.ts`
   * whenever the worker fleet is available, i.e. normally — it is optional only so a
   * test (or a host-only embedding) can build the proxy without the fleet graph. The
   * old comment said "absent today", which stopped being true when phase 1c #5
   * landed and sent readers looking for a code path that does not exist (#751).
   */
  remote?: AgentExecutionService;
}

/**
 * A dispatching AgentExecutionService: routes `launch` by the requested
 * Placement and remembers which implementation owns each sessionId so the
 * session-keyed follow-ups reach the same one. A remote placement with no
 * remote implementation registered degrades loudly to host (mirrors the
 * devcontainer best-effort downgrade contract).
 */
export function createAgentDispatch(implementations: AgentDispatchImplementations): AgentExecutionService {
  const bySession = new Map<string, AgentExecutionService>();

  const resolveImplementation = (sessionId: string, placement?: Placement): AgentExecutionService => {
    if (placement?.kind === "remote") {
      if (implementations.remote) return implementations.remote;
      if (placement.strict) {
        throw new WorkerDispatchUnavailableError(
          `remote placement requested (workerId=${placement.workerId}) but no remote implementation is registered, ` +
          `and worker dispatch is strict: sessionId=${sessionId}`,
        );
      }
      console.warn(
        `[agent-dispatch] remote placement requested (workerId=${placement.workerId}) but no remote implementation is registered; falling back to host: sessionId=${sessionId}`,
      );
    }
    return implementations.host;
  };

  const forSession = (sessionId: string): AgentExecutionService => {
    const known = bySession.get(sessionId);
    if (known) return known;
    // #874: ASK before defaulting. A routing entry is only ever written by `launch`,
    // so an adopted session has none — and the host default answers every
    // session-keyed query about it wrongly. The remote service's own map is the
    // authority, which is also why this cannot drift the way a second registry would.
    const remote = implementations.remote;
    if (remote?.tracksSession?.(sessionId) === true) return remote;
    return implementations.host;
  };

  return {
    launch(request) {
      const { sessionId, placement, onOutput } = request;
      const impl = resolveImplementation(sessionId, placement);
      const reservationId = reservationIdOf(placement);
      if (impl === implementations.host) releaseWorkerSlot(reservationId);
      bySession.set(sessionId, impl);
      const onOutputWithCleanup: AgentOutputCallback = (event) => {
        if (event.type === "exit") {
          bySession.delete(sessionId);
          releaseWorkerSlot(reservationId);
        }
        onOutput(event);
      };
      // The placement's capacity slot now belongs to this session, so it stops
      // counting on its own: the connection manager counts the session from the
      // moment the assign lands, and counting both would make one dispatch look
      // like two (#751).
      if (reservationId && impl !== implementations.host) claimWorkerSlot(reservationId, sessionId);

      /**
       * The host-fallback / strict rule for a failure discovered AFTER `launch`
       * returned. Shared with the synchronous catch below, because strictness is a
       * property of the DECISION and not of which code path happened to notice the
       * failure (#245, #751).
       */
      const handleLateLaunchFailure = (failure: DeferredLaunchFailure): void => {
        bySession.delete(sessionId);
        releaseWorkerSlot(reservationId);
        const detail = `${failure.kind}: ${failure.reason}`;
        if (placement?.kind === "remote" && placement.strict) {
          // Nothing to throw to — `launch` returned long ago. The session has to be
          // finalized through its own output channel, and it has to say that this
          // was a DISPATCH failure: an operator reading a bare "exit 1" cannot tell
          // "no worker took it" from "a worker took it and the launch died".
          console.warn(
            `[agent-dispatch] deferred remote launch failure under STRICT worker dispatch; refusing the host fallback: sessionId=${sessionId}: ${detail}`,
          );
          onOutput({
            type: "stderr",
            sessionId,
            data:
              `${DISPATCH_LAUNCH_FAILURE_PREFIX} NO_AVAILABLE_WORKER — remote launch on worker ` +
              `${placement.workerId} failed (${detail}) and worker dispatch is strict for this project.`,
          });
          onOutput({ type: "exit", sessionId, exitCode: 1 });
          return;
        }
        console.warn(
          `[agent-dispatch] deferred non-host launch failure (${detail}); relaunching on host: sessionId=${sessionId}`,
        );
        try {
          bySession.set(sessionId, implementations.host);
          implementations.host.launch({
            ...request,
            onOutput: onOutputWithCleanup,
            placement: { kind: "host" },
            onDeferredLaunchFailure: undefined,
          });
        } catch (err) {
          bySession.delete(sessionId);
          onOutput({
            type: "stderr",
            sessionId,
            data:
              `${DISPATCH_LAUNCH_FAILURE_PREFIX} remote launch failed (${detail}) and the host fallback ` +
              `also failed: ${errorMessage(err)}`,
          });
          onOutput({ type: "exit", sessionId, exitCode: 1 });
        }
      };

      // A late failure is handled exactly once, by whichever of the two paths sees
      // it first — the synchronous catch below or the deferred hook.
      let launchSettled = false;
      const relayed: AgentLaunchRequest = {
        ...request,
        onOutput: onOutputWithCleanup,
        onDeferredLaunchFailure: (failure) => {
          if (launchSettled) return;
          launchSettled = true;
          handleLateLaunchFailure(failure);
        },
      };

      try {
        return impl.launch(relayed);
      } catch (err) {
        // A remote launch can race the worker disconnecting between placement
        // and assign. Degrade to host rather than failing the session — UNLESS
        // the project forbids host execution (#245), in which case the session
        // must fail with NO_AVAILABLE_WORKER instead of quietly running here.
        if (impl === implementations.host) throw err;
        launchSettled = true;
        const detail = errorMessage(err);
        releaseWorkerSlot(reservationId);
        if (placement?.kind === "remote" && placement.strict) {
          console.warn(
            `[agent-dispatch] remote launch failed under STRICT worker dispatch; refusing the host fallback: sessionId=${sessionId}: ${detail}`,
          );
          bySession.delete(sessionId);
          throw new WorkerDispatchUnavailableError(
            `remote launch on worker ${placement.workerId} failed (${detail}) and worker dispatch is strict for this project`,
          );
        }
        console.warn(
          `[agent-dispatch] non-host launch failed (${detail}); falling back to host: sessionId=${sessionId}`,
        );
        bySession.set(sessionId, implementations.host);
        // The fallback differs from the relayed request in exactly one field, which is
        // now visible instead of being the twentieth positional argument.
        return implementations.host.launch({
          ...relayed,
          placement: { kind: "host" },
          onDeferredLaunchFailure: undefined,
        });
      }
    },
    kill(sessionId) {
      // NON-MUTATING (#751). This used to drop the routing entry before killing,
      // so between the kill and the worker's exit event every session-keyed query
      // (`isPidAlive`, `getProcess`, `isStdinOpen`) was answered by the HOST
      // implementation — which has never heard of the session and reports it gone,
      // while the remote service still holds it and is still streaming its output.
      // The exit event clears the entry, which is the moment the session is
      // genuinely over; a kill only asks for that to happen.
      return forSession(sessionId).kill(sessionId);
    },
    sendInput: (sessionId, content) => forSession(sessionId).sendInput(sessionId, content),
    closeStdin: (sessionId) => forSession(sessionId).closeStdin(sessionId),
    isStdinOpen: (sessionId) => forSession(sessionId).isStdinOpen(sessionId),
    getProcess: (sessionId) => forSession(sessionId).getProcess(sessionId),
    getPid: (sessionId) => forSession(sessionId).getPid(sessionId),
    isPidAlive: (sessionId) => forSession(sessionId).isPidAlive(sessionId),
    tracksSession: (sessionId) =>
      bySession.has(sessionId) || implementations.remote?.tracksSession?.(sessionId) === true,
    placementOf(sessionId) {
      const impl = forSession(sessionId);
      if (implementations.remote && impl === implementations.remote) return "remote";
      // Only claim `host` when there is a record. Falling back to host for an unknown
      // id is what routing must do; SAYING "host" about it would be inventing a fact.
      return bySession.has(sessionId) ? "host" : undefined;
    },
  };
}

function reservationIdOf(placement?: Placement): string | undefined {
  return placement?.kind === "remote" ? placement.reservationId : undefined;
}
