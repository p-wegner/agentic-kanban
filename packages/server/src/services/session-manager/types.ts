import type { WSContext } from "hono/ws";
import type { ProviderName } from "../agent-provider.js";
import type { Placement } from "../agent-dispatch.service.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import type { TodoItem } from "../board-events.js";

export interface Subscriber {
  ws: WSContext;
}

export interface SessionContext {
  workspaceId: string;
  issueId: string;
  projectId: string;
}

export interface SessionManagerOptions {
  onSessionExit?: (workspaceId: string, sessionId: string, exitCode: number | null, wasPlanMode?: boolean) => void;
  onActivity?: (projectId: string, issueId: string, sessionId: string, activity: string) => void;
  onLiveStats?: (projectId: string, issueId: string, model: string, contextTokens: number, toolUses: number, subagentCount: number) => void;
  onTodos?: (projectId: string, issueId: string, todos: TodoItem[]) => void;
}

export interface StartSessionOptions {
  workspaceId: string;
  prompt: string;
  agentCommand?: string;
  agentArgs?: string;
  resumeFromId?: string;
  multiTurn?: boolean;
  permissionPromptTool?: string;
  planMode?: boolean;
  resumeWithNewModel?: boolean;
  provider?: import("../agent-provider.js").ProviderId;
  triggerType?: string;
  /**
   * The profile this session launches under. #528: the parallel `claudeProfile`
   * string is gone -- callers set both from the same `AgentSettings` fields, where
   * `claudeProfile` was already just `provider === "claude" ? profile.name : undefined`.
   */
  profile?: { provider: ProviderName; name: string };
  /** Claude model tier (e.g. "opus"). When omitted, the workspace's stored model is used. */
  model?: string;
  /** Optional system-facing guardrails for the provider launch. */
  systemInstructions?: string;
  /** Files to expose to the provider on this session's initial turn when supported. */
  contextFiles?: string[];
  extraEnv?: Record<string, string>;
  workingDirOverride?: string;
  /** Skip the generic launch preflight when the caller already prepared the worktree. */
  skipLaunchPreflight?: boolean;
  /**
   * #920: forbid the launch preflight's own update-base rebase (`git rebase --autostash
   * <baseBranch>`) even when the rest of the preflight still runs. When omitted, the
   * lifecycle resolves this from the `auto_rebase_on_continue` preference so the preflight's
   * rebase and the caller's own auto-rebase gate agree — previously the preflight rebased
   * unconditionally, so disabling `auto_rebase_on_continue` never actually stopped it, and a
   * branch containing merge commits (which cannot replay linearly) became permanently
   * unrelaunchable.
   */
  allowUpdateBaseRebase?: boolean;
  skipPermissions?: boolean;
  /**
   * Where this session's agent should execute (worker-fleet seam, epic #1).
   * Omitted = host. Routed by the agent dispatch proxy; only host exists today.
   */
  placement?: Placement;
}

export interface DbWriteBufferEntry {
  type: string;
  data: string | null;
  exitCode: string | null;
}

export interface SessionState {
  subscribers: Map<string, Map<WSContext, Subscriber>>;
  messageBuffer: Map<string, AgentOutputMessage[]>;
  sessionContexts: Map<string, SessionContext>;
  turnStates: Map<string, "processing" | "waiting">;
  stoppedByUser: Set<string>;
  sessionToolUses: Map<string, number>;
  sessionModels: Map<string, string>;
  sessionSubagents: Map<string, number>;
  sessionContextTokens: Map<string, number>;
  sessionLastTool: Map<string, string>;
  sessionAgentToolUseIds: Map<string, Set<string>>;
  sessionTextParts: Map<string, string[]>;
  sessionFinalText: Map<string, string>;
  sessionSubstantiveOutput: Set<string>;
  sessionTasks: Map<string, Map<string, { subject: string; status: string }>>;
  sessionHasTodoWrite: Set<string>;
  sessionExitPlanModeDenied: Set<string>;
  sessionExitHandled: Set<string>;
  workspaceAutoResumeCount: Map<string, number>;
  /** Bounds the missing-transcript fallback (#26) to one automatic retry per workspace. */
  workspaceStaleResumeRecoveryCount: Map<string, number>;
  sessionProviders: Map<string, string>;
  dbWriteBuffer: Map<string, DbWriteBufferEntry[]>;
  dbWriteTimers: Map<string, ReturnType<typeof setTimeout>>;
}

/**
 * Clear every per-session transient map/set for a session that has TERMINATED (#543).
 *
 * This existed as hand-maintained delete-lists at several call sites, and they had
 * drifted: `cleanupStaleSession` cleared 14 members while `notifyExternalExit` cleared
 * those same 14 PLUS `messageBuffer`, `sessionTextParts`, `sessionFinalText`,
 * `stoppedByUser` and `sessionExitPlanModeDenied` — so a stale-session cleanup leaked
 * every buffered message of that session for the process's lifetime. A list that must be
 * updated by hand whenever `SessionState` gains a member is a leak waiting to be
 * reintroduced, which is the actual argument for this function.
 *
 * Deliberately NOT cleared:
 *  - `subscribers` — WebSocket listeners have their own unsubscribe lifecycle; dropping
 *    them here would silently disconnect a client that is still attached.
 *  - `sessionExitHandled` — the duplicate-exit guard. It must OUTLIVE teardown at the
 *    external-exit site (a second notification for the same session has to stay ignored),
 *    and the live path deletes it itself once its finalize promise settles.
 *  - `workspaceAutoResumeCount` / `workspaceStaleResumeRecoveryCount` — keyed by
 *    WORKSPACE, not session. Clearing them per session would reset the loop bounds those
 *    counters exist to enforce.
 *
 * Not used by `stopSession` (the process is still alive and its exit event still needs the
 * buffers) nor by `broadcast()`'s exit block (which also SETS `sessionFinalText` from
 * `sessionTextParts`, so it is ordering-sensitive rather than pure teardown).
 */
export function teardownSessionState(state: SessionState, sessionId: string): void {
  state.messageBuffer.delete(sessionId);
  state.sessionContexts.delete(sessionId);
  state.turnStates.delete(sessionId);
  state.stoppedByUser.delete(sessionId);
  state.sessionToolUses.delete(sessionId);
  state.sessionModels.delete(sessionId);
  state.sessionSubagents.delete(sessionId);
  state.sessionContextTokens.delete(sessionId);
  state.sessionLastTool.delete(sessionId);
  state.sessionAgentToolUseIds.delete(sessionId);
  state.sessionTextParts.delete(sessionId);
  state.sessionFinalText.delete(sessionId);
  state.sessionSubstantiveOutput.delete(sessionId);
  state.sessionTasks.delete(sessionId);
  state.sessionHasTodoWrite.delete(sessionId);
  state.sessionExitPlanModeDenied.delete(sessionId);
  state.sessionProviders.delete(sessionId);

  const pendingTimer = state.dbWriteTimers.get(sessionId);
  if (pendingTimer !== undefined) {
    clearTimeout(pendingTimer);
    state.dbWriteTimers.delete(sessionId);
  }
  state.dbWriteBuffer.delete(sessionId);
}

export function createSessionState(): SessionState {
  return {
    subscribers: new Map(),
    messageBuffer: new Map(),
    sessionContexts: new Map(),
    turnStates: new Map(),
    stoppedByUser: new Set(),
    sessionToolUses: new Map(),
    sessionModels: new Map(),
    sessionSubagents: new Map(),
    sessionContextTokens: new Map(),
    sessionLastTool: new Map(),
    sessionAgentToolUseIds: new Map(),
    sessionTextParts: new Map(),
    sessionFinalText: new Map(),
    sessionSubstantiveOutput: new Set(),
    sessionTasks: new Map(),
    sessionHasTodoWrite: new Set(),
    sessionExitPlanModeDenied: new Set(),
    sessionExitHandled: new Set(),
    workspaceAutoResumeCount: new Map(),
    workspaceStaleResumeRecoveryCount: new Map(),
    sessionProviders: new Map(),
    dbWriteBuffer: new Map(),
    dbWriteTimers: new Map(),
  };
}
