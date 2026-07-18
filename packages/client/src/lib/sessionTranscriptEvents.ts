import type { AgentOutputFormat } from "./agent-output-parser.js";

/**
 * Window CustomEvent that opens the full session transcript viewer (#87).
 * Using a window event (like `BOARD_WS_EVENT`) lets every launch site — an
 * AgentGrid cell, an AllWorkspacesPanel row, workspace detail, the live ticker —
 * open the single mounted panel without threading show/close props through the
 * whole board tree.
 */
export const OPEN_SESSION_TRANSCRIPT_EVENT = "agentic-kanban:open-session-transcript";

/**
 * Window CustomEvent re-dispatched for every WS `session_activity` message so the
 * transcript panel can live-append while open without opening its own WebSocket.
 */
export const SESSION_ACTIVITY_WS_EVENT = "agentic-kanban:session-activity";

export interface SessionTranscriptTarget {
  /** Explicit session to show. If omitted, the latest session of `workspaceId` is used. */
  sessionId?: string;
  /** Resolve the latest session and/or the output format (from the workspace's provider). */
  workspaceId?: string;
  /** Override the stream format; otherwise derived from the workspace provider. */
  outputFormat?: AgentOutputFormat;
  /** Human label for the panel header. */
  title?: string;
}

export interface SessionActivityEventDetail {
  projectId: string;
  issueId: string;
  sessionId: string;
  activity: string;
}

/** Open the transcript viewer for a session or workspace. */
export function openSessionTranscript(target: SessionTranscriptTarget): void {
  window.dispatchEvent(
    new CustomEvent<SessionTranscriptTarget>(OPEN_SESSION_TRANSCRIPT_EVENT, { detail: target }),
  );
}
