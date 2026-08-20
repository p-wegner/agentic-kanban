// Session / agent-launch / session-summary wire-contract types (pure DTOs).
// See ../api.ts barrel.

export interface LaunchAgentRequest {
  prompt: string;
  agentCommand?: string;
  resumeFromId?: string;
}

export interface SessionResponse {
  id: string;
  workspaceId: string;
  executor: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  providerSessionId?: string | null;
  resumeFromId?: string | null;
}

export interface AgentOutputMessage {
  type: "stdout" | "stderr" | "exit" | "bisect";
  sessionId: string;
  data?: string;
  exitCode?: number | null;
}

export interface SessionSummaryAction {
  type: string;
  files?: string[];
  commands?: string[];
}

export interface SessionTaskItem {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
}

export interface SessionSummaryResponse {
  sessionId: string;
  duration: string | null;
  stats: Record<string, unknown> | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  overview: string;
  agentSummary: string | null;
  actions: SessionSummaryAction[];
  keyExcerpts: string[];
  errors: string[];
  filesRead: string[];
  filesEdited: string[];
  filesWritten: string[];
  commandsRun: string[];
  model: string;
  tasks: SessionTaskItem[];
}
