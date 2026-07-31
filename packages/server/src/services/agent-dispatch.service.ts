// Execution-placement seam for the worker-fleet architecture (#1, phase 0 #2).
//
// `agent.service.ts` runs agents as HOST subprocesses (optionally wrapped into a
// `docker exec` by container-wrap). A remote worker is a different EXECUTION
// SERVICE, not a different launch config — so the seam is an interface over the
// session-keyed surface the session lifecycle consumes, plus a dispatching proxy
// that picks an implementation per launch and remembers the choice for the
// follow-up calls (kill/sendInput/closeStdin/...) that arrive keyed by sessionId
// only. Today only the host implementation exists; the proxy is deliberately a
// near-identity wrapper that establishes the routing contract remote dispatch
// (phase 1c #5) will plug into.

import type { AgentOutputCallback } from "./agent.service.js";
import type { ProviderId, ProviderName } from "./agent-provider.js";
import type { ContainerProvision } from "./devcontainer-workspace.service.js";

/**
 * Where a session's agent should execute. Carried through StartSessionOptions.
 * `container` placement currently still travels as the separate
 * `containerProvision` launch argument (folded into this union in phase 1c);
 * `remote` names a connected worker from the worker registry (phase 1a).
 */
export type Placement =
  | { kind: "host" }
  | { kind: "container" }
  | { kind: "remote"; workerId: string };

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
export interface AgentExecutionService {
  launch(
    worktreePath: string,
    sessionId: string,
    prompt: string,
    agentArgs: string | undefined,
    onOutput: AgentOutputCallback,
    providerSessionId?: string,
    agentCommand?: string,
    claudeProfile?: string,
    keepAlive?: boolean,
    permissionPromptTool?: string,
    planMode?: boolean,
    provider?: ProviderId,
    profile?: { provider: ProviderName; name: string },
    extraEnv?: Record<string, string>,
    skipPermissions?: boolean,
    model?: string,
    contextFiles?: string[],
    systemInstructions?: string,
    containerProvision?: ContainerProvision,
    placement?: Placement,
  ): AgentHandle;
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
      console.warn(
        `[agent-dispatch] remote placement requested (workerId=${placement.workerId}) but no remote implementation is registered; falling back to host: sessionId=${sessionId}`,
      );
    }
    return implementations.host;
  };

  const forSession = (sessionId: string): AgentExecutionService =>
    bySession.get(sessionId) ?? implementations.host;

  return {
    launch(
      worktreePath, sessionId, prompt, agentArgs, onOutput,
      providerSessionId, agentCommand, claudeProfile, keepAlive, permissionPromptTool,
      planMode, provider, profile, extraEnv, skipPermissions,
      model, contextFiles, systemInstructions, containerProvision, placement,
    ) {
      const impl = resolveImplementation(sessionId, placement);
      bySession.set(sessionId, impl);
      const onOutputWithCleanup: AgentOutputCallback = (event) => {
        if (event.type === "exit") bySession.delete(sessionId);
        onOutput(event);
      };
      try {
        return impl.launch(
          worktreePath, sessionId, prompt, agentArgs, onOutputWithCleanup,
          providerSessionId, agentCommand, claudeProfile, keepAlive, permissionPromptTool,
          planMode, provider, profile, extraEnv, skipPermissions,
          model, contextFiles, systemInstructions, containerProvision, placement,
        );
      } catch (err) {
        // A remote launch can race the worker disconnecting between placement
        // and assign. Degrade to host rather than failing the session.
        if (impl === implementations.host) throw err;
        console.warn(
          `[agent-dispatch] non-host launch failed (${err instanceof Error ? err.message : String(err)}); falling back to host: sessionId=${sessionId}`,
        );
        bySession.set(sessionId, implementations.host);
        return implementations.host.launch(
          worktreePath, sessionId, prompt, agentArgs, onOutputWithCleanup,
          providerSessionId, agentCommand, claudeProfile, keepAlive, permissionPromptTool,
          planMode, provider, profile, extraEnv, skipPermissions,
          model, contextFiles, systemInstructions, containerProvision, { kind: "host" },
        );
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
