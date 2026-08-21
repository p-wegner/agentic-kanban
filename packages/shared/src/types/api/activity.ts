// Activity-feed wire DTOs (#704). See ../api.ts barrel.

export interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  summary: string;
  actor: string | null;
  timestamp: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  commentKind?: string | null;
}

export type ActivityEventType =
  | "issue_created"
  | "status_changed"
  | "workspace_created"
  | "workspace_launched"
  | "workspace_merged"
  | "workspace_closed"
  | "session_started"
  | "session_completed"
  | "session_failed"
  | "session_stopped"
  | "comment";

export interface ProjectActivityResult {
  events: ProjectActivityEvent[];
  generatedAt: string;
}

export interface ProjectActivityEvent {
  id: string;
  /** #704: narrowed to the union the client already assumed; the server produces only these. */
  type: ActivityEventType;
  summary: string;
  actor: string | null;
  timestamp: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  commentKind?: string | null;
}
