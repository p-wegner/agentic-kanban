import { useEffect, useRef, useCallback } from "react";
import { SESSION_ACTIVITY_WS_EVENT, type SessionActivityEventDetail } from "./sessionTranscriptEvents.js";

/**
 * Low-frequency safety poll backing the board WebSocket. The WS is the single
 * push channel that drives board refreshes (#907); this interval exists only as
 * a backstop for mutations that bypass the WS broadcast — MCP/CLI edits and
 * second-tab changes. It is visibility-gated (skipped while the tab is hidden,
 * with one catch-up refresh when it becomes visible) so background tabs don't
 * hit the server. There is now exactly one board poller, so the former
 * phase-offset "stagger" (which existed only to spread multiple independent
 * pollers) is gone — the fix removes redundant pollers, it does not stagger them.
 */
const POLL_INTERVAL_MS = 30_000;

/**
 * Window event re-dispatched for every WS `board_changed` message so always-on
 * widgets (e.g. the agent-questions badge) can refresh on relevant server
 * events without each opening its own WebSocket or threading new props
 * through BoardPage. detail: { projectId: string, reason: string }.
 */
export const BOARD_WS_EVENT = "agentic-kanban:board-ws-event";

export interface BoardWsEventDetail {
  projectId: string;
  reason: string;
}

interface BoardChangedEvent {
  type: "board_changed";
  projectId: string;
  reason: string;
}

interface ProjectsChangedEvent {
  type: "projects_changed";
  projectId: string;
  reason: "project_created" | "project_updated" | "project_deleted";
}

interface SessionActivityEvent {
  type: "session_activity";
  projectId: string;
  issueId: string;
  sessionId: string;
  activity: string;
}

interface SessionStatsEvent {
  type: "session_stats";
  projectId: string;
  issueId: string;
  model: string;
  contextTokens: number;
  toolUses: number;
  subagentCount?: number;
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

interface SessionTodosEvent {
  type: "session_todos";
  projectId: string;
  issueId: string;
  todos: TodoItem[];
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  workspaceId?: string;
}

interface ApprovalRequestedEvent {
  type: "approval_requested";
  projectId: string;
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  workspaceId?: string;
}

type BoardWsEvent = BoardChangedEvent | ProjectsChangedEvent | SessionActivityEvent | SessionStatsEvent | SessionTodosEvent | ApprovalRequestedEvent;

export interface LiveSessionStats {
  model: string;
  contextTokens: number;
  toolUses: number;
  subagentCount: number;
}

export function useBoardEvents(
  projectId: string | null,
  onBoardChange: (reason: string) => void,
  onSessionActivity?: (issueId: string, sessionId: string, activity: string) => void,
  onSessionStats?: (issueId: string, stats: LiveSessionStats) => void,
  onSessionTodos?: (issueId: string, todos: TodoItem[]) => void,
  onApprovalRequested?: (req: ApprovalRequest) => void,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1000);
  const unmountedRef = useRef(false);
  const onBoardChangeRef = useRef(onBoardChange);
  const onSessionActivityRef = useRef(onSessionActivity);
  const onSessionStatsRef = useRef(onSessionStats);
  const onSessionTodosRef = useRef(onSessionTodos);
  const onApprovalRequestedRef = useRef(onApprovalRequested);
  onBoardChangeRef.current = onBoardChange;
  onSessionActivityRef.current = onSessionActivity;
  onSessionStatsRef.current = onSessionStats;
  onSessionTodosRef.current = onSessionTodos;
  onApprovalRequestedRef.current = onApprovalRequested;

  const connectRef = useRef<() => void>(() => {});

  const connect = useCallback(() => {
    if (unmountedRef.current) return;

    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const subscriptionProjectId = projectId ?? "__projects";
    const url = `${protocol}//${window.location.host}/ws/board/${subscriptionProjectId}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectDelayRef.current = 1000;
      // Refresh board data immediately on reconnect to pick up changes during disconnect
      onBoardChangeRef.current("reconnect");
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as BoardWsEvent;
        if (msg.type === "board_changed") {
          onBoardChangeRef.current(msg.reason);
          window.dispatchEvent(
            new CustomEvent<BoardWsEventDetail>(BOARD_WS_EVENT, {
              detail: { projectId: msg.projectId, reason: msg.reason },
            }),
          );
        } else if (msg.type === "projects_changed") {
          onBoardChangeRef.current(msg.reason);
        } else if (msg.type === "session_activity") {
          onSessionActivityRef.current?.(msg.issueId, msg.sessionId, msg.activity);
          window.dispatchEvent(
            new CustomEvent<SessionActivityEventDetail>(SESSION_ACTIVITY_WS_EVENT, {
              detail: { projectId: msg.projectId, issueId: msg.issueId, sessionId: msg.sessionId, activity: msg.activity },
            }),
          );
        } else if (msg.type === "session_stats") {
          onSessionStatsRef.current?.(msg.issueId, { model: msg.model, contextTokens: msg.contextTokens, toolUses: msg.toolUses ?? 0, subagentCount: msg.subagentCount ?? 0 });
        } else if (msg.type === "session_todos") {
          onSessionTodosRef.current?.(msg.issueId, msg.todos);
        } else if (msg.type === "approval_requested") {
          onApprovalRequestedRef.current?.({ id: msg.id, sessionId: msg.sessionId, toolName: msg.toolName, toolInput: msg.toolInput, workspaceId: msg.workspaceId });
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onerror = () => {
      // Error will be followed by onclose — let reconnect handle it
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (unmountedRef.current) return;
      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(delay * 2, 30_000);
      reconnectTimerRef.current = setTimeout(() => connectRef.current(), delay);
    };
  }, [projectId]);

  connectRef.current = connect;

  useEffect(() => {
    unmountedRef.current = false;
    reconnectDelayRef.current = 1000;
    connect();

    // The single low-frequency safety poll backing the WS (see POLL_INTERVAL_MS
    // doc). Visibility-gated: ticks are skipped while the tab is hidden, and one
    // catch-up refresh runs when it becomes visible again so the board isn't
    // stale on tab focus. (Headless Chromium reports visible, so E2E is unchanged.)
    let missedWhileHidden = false;
    const onVisibilityChange = () => {
      if (unmountedRef.current) return;
      if (typeof document !== "undefined" && !document.hidden && missedWhileHidden) {
        missedWhileHidden = false;
        onBoardChangeRef.current("poll");
      }
    };
    if (projectId) {
      pollTimerRef.current = setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) {
          missedWhileHidden = true;
          return;
        }
        onBoardChangeRef.current("poll");
      }, POLL_INTERVAL_MS);
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVisibilityChange);
      }
    }

    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [connect, projectId]);
}
