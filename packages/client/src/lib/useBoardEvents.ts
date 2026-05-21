import { useEffect, useRef, useCallback } from "react";

const POLL_INTERVAL_MS = 30_000;

interface BoardChangedEvent {
  type: "board_changed";
  projectId: string;
  reason: string;
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

type BoardWsEvent = BoardChangedEvent | SessionActivityEvent | SessionStatsEvent | SessionTodosEvent | ApprovalRequestedEvent;

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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
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

  const connect = useCallback(() => {
    if (!projectId) return;

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws/board/${projectId}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const msg: BoardWsEvent = JSON.parse(event.data);
        if (msg.type === "board_changed") {
          onBoardChangeRef.current(msg.reason);
        } else if (msg.type === "session_activity") {
          onSessionActivityRef.current?.(msg.issueId, msg.sessionId, msg.activity);
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
      // Silently ignore — board events are nice-to-have
    };

    return ws;
  }, [projectId]);

  useEffect(() => {
    const ws = connect();

    // Periodic polling fallback — catches MCP mutations, second-tab changes,
    // CLI edits, and any other mutations that bypass WS broadcast.
    if (projectId) {
      pollRef.current = setInterval(() => {
        onBoardChangeRef.current("poll");
      }, POLL_INTERVAL_MS);
    }

    return () => {
      if (ws) {
        ws.close();
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [connect, projectId]);
}
