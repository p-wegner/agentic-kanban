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
import type { ProviderId, ProviderName } from "./agent-provider.js";
import type { ContainerProvision } from "./devcontainer-workspace.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

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
  | { kind: "host" }
  | { kind: "container" }
  | {
      kind: "remote";
      workerId: string;
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
}

export interface AgentExecutionService {
  launch(request: AgentLaunchRequest): AgentHandle;
  kill(sessionId: string): boolean;
  sendInput(sessionId: string, content: string): boolean;
  closeStdin(sessionId: string): boolean;
  isStdinOpen(sessionId: string): boolean;
  getProcess(sessionId: string): AgentHandle | undefined;
  getPid(sessionId: string): number | undefined;
  isPidAlive(sessionId: string): boolean;
}

export interface AgentDispatchImplementations {
  host: AgentExecutionService;
  /** Registered by the worker-fleet remote service (phase 1c); absent today. */
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

  const forSession = (sessionId: string): AgentExecutionService =>
    bySession.get(sessionId) ?? implementations.host;

  return {
    launch(request) {
      const { sessionId, placement, onOutput } = request;
      const impl = resolveImplementation(sessionId, placement);
      bySession.set(sessionId, impl);
      const onOutputWithCleanup: AgentOutputCallback = (event) => {
        if (event.type === "exit") bySession.delete(sessionId);
        onOutput(event);
      };
      const relayed: AgentLaunchRequest = { ...request, onOutput: onOutputWithCleanup };
      try {
        return impl.launch(relayed);
      } catch (err) {
        // A remote launch can race the worker disconnecting between placement
        // and assign. Degrade to host rather than failing the session — UNLESS
        // the project forbids host execution (#245), in which case the session
        // must fail with NO_AVAILABLE_WORKER instead of quietly running here.
        if (impl === implementations.host) throw err;
        if (placement?.kind === "remote" && placement.strict) {
          const detail = errorMessage(err);
          console.warn(
            `[agent-dispatch] remote launch failed under STRICT worker dispatch; refusing the host fallback: sessionId=${sessionId}: ${detail}`,
          );
          bySession.delete(sessionId);
          throw new WorkerDispatchUnavailableError(
            `remote launch on worker ${placement.workerId} failed (${detail}) and worker dispatch is strict for this project`,
          );
        }
        console.warn(
          `[agent-dispatch] non-host launch failed (${errorMessage(err)}); falling back to host: sessionId=${sessionId}`,
        );
        bySession.set(sessionId, implementations.host);
        // The fallback differs from the relayed request in exactly one field, which is
        // now visible instead of being the twentieth positional argument.
        return implementations.host.launch({ ...relayed, placement: { kind: "host" } });
      }
    },
    kill(sessionId) {
      const impl = forSession(sessionId);
      bySession.delete(sessionId);
      return impl.kill(sessionId);
    },
    sendInput: (sessionId, content) => forSession(sessionId).sendInput(sessionId, content),
    closeStdin: (sessionId) => forSession(sessionId).closeStdin(sessionId),
    isStdinOpen: (sessionId) => forSession(sessionId).isStdinOpen(sessionId),
    getProcess: (sessionId) => forSession(sessionId).getProcess(sessionId),
    getPid: (sessionId) => forSession(sessionId).getPid(sessionId),
    isPidAlive: (sessionId) => forSession(sessionId).isPidAlive(sessionId),
  };
}
