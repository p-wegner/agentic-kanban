import type { WSContext } from "hono/ws";
import type { ParsedStreamEvent, ProviderName } from "../agent-provider.js";
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
  claudeProfile?: string;
  multiTurn?: boolean;
  permissionPromptTool?: string;
  planMode?: boolean;
  resumeWithNewModel?: boolean;
  provider?: import("../agent-provider.js").ProviderId;
  triggerType?: string;
  profile?: { provider: ProviderName; name: string };
  /** Claude model tier (e.g. "opus"). When omitted, the workspace's stored model is used. */
  model?: string;
  extraEnv?: Record<string, string>;
  workingDirOverride?: string;
  skipPermissions?: boolean;
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
  sessionTasks: Map<string, Map<string, { subject: string; status: string }>>;
  sessionHasTodoWrite: Set<string>;
  sessionExitPlanModeDenied: Set<string>;
  workspaceAutoResumeCount: Map<string, number>;
  sessionProviders: Map<string, string>;
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
    sessionTasks: new Map(),
    sessionHasTodoWrite: new Set(),
    sessionExitPlanModeDenied: new Set(),
    workspaceAutoResumeCount: new Map(),
    sessionProviders: new Map(),
  };
}
