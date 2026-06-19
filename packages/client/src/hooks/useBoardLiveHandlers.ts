import { useCallback } from "react";
import type { StatusWithIssues } from "@agentic-kanban/shared";
import { useBoardEvents, type LiveSessionStats, type TodoItem, type ApprovalRequest } from "../lib/useBoardEvents.js";
import { sendDesktopNotification } from "../lib/desktop.js";
import { showToast } from "../lib/toast.js";

type NotificationIssue = { id: string; issueNumber?: number; title?: string; workspaceId?: string };

interface UseBoardLiveHandlersDeps {
  activeProjectId: string | null;
  columnsRef: React.RefObject<StatusWithIssues[]>;
  loadProjectsRef: React.RefObject<() => Promise<string | undefined>>;
  pendingBoardRefreshRef: React.RefObject<boolean>;
  refetchBoard: (projectId?: string) => Promise<StatusWithIssues[] | undefined> | void;
  scheduleRefetch: () => void;
  setColumns: React.Dispatch<React.SetStateAction<StatusWithIssues[]>>;
  creatingInColumnId: string | null;
  setSessionActivityRaw: React.Dispatch<React.SetStateAction<Record<string, Record<string, string>>>>;
  setLiveStats: React.Dispatch<React.SetStateAction<Record<string, LiveSessionStats>>>;
  setSessionTodos: React.Dispatch<React.SetStateAction<Record<string, TodoItem[]>>>;
  setApprovalRequests: React.Dispatch<React.SetStateAction<ApprovalRequest[]>>;
  addNotificationBoardEvent: (reason: string, issue?: NotificationIssue) => void;
  addNotificationApprovalEvent: (key: string, issue?: NotificationIssue) => void;
}

/**
 * The board's live-event handling, extracted from BoardPage: defines the
 * board-changed / session-activity / session-stats / session-todos /
 * approval-requested handlers and wires them to the websocket via useBoardEvents.
 * State stays in BoardPage; this hook receives the setters + refs it needs.
 */
export function useBoardLiveHandlers(deps: UseBoardLiveHandlersDeps) {
  const {
    activeProjectId,
    columnsRef,
    loadProjectsRef,
    pendingBoardRefreshRef,
    refetchBoard,
    scheduleRefetch,
    setColumns,
    creatingInColumnId,
    setSessionActivityRaw,
    setLiveStats,
    setSessionTodos,
    setApprovalRequests,
    addNotificationBoardEvent,
    addNotificationApprovalEvent,
  } = deps;

  const handleBoardChange = useCallback((reason: string) => {
    // `project_created/updated/deleted` are project-lifecycle reasons that require a
    // project-list reload. `project_completed` (#848) shares the `project_` prefix but is
    // a board notification, NOT a lifecycle change — let it fall through to the
    // notification handling below instead of swallowing it with an early return.
    if (reason.startsWith("project_") && reason !== "project_completed") {
      void (async () => {
        try {
          const nextProjectId = await loadProjectsRef.current();
          if (nextProjectId) {
            await refetchBoard(nextProjectId);
          } else {
            setColumns([]);
            columnsRef.current = [];
          }
        } catch {
          showToast("Failed to refresh projects", "error");
        }
      })();
      return;
    }

    if (reason === "session_completed") {
      sendDesktopNotification("Agentic Kanban", "Agent session completed");
    } else if (reason === "workspace_merged") {
      sendDesktopNotification("Agentic Kanban", "Workspace merged successfully");
    } else if (reason === "project_completed") {
      sendDesktopNotification("Agentic Kanban", "🎉 Project complete — the backlog is fully implemented");
    }

    // Activity notification bell — capture issue context from current board snapshot
    const relevantReasons = new Set([
      "workspace_merged", "workspace_ready_for_merge",
      "session_completed", "session_launched",
      "workflow_error", "workflow_transition",
      "project_completed",
    ]);
    if (relevantReasons.has(reason)) {
      let bestIssue: NotificationIssue | undefined;
      if (reason !== "workflow_transition" && reason !== "project_completed") {
        let bestTime = 0;
        for (const col of columnsRef.current) {
          for (const iss of col.issues) {
            const ws = iss.workspaceSummary?.main;
            if (ws) {
              const wsTime = ws.lastSessionAt ? new Date(ws.lastSessionAt).getTime() : 0;
              if (wsTime > bestTime) {
                bestTime = wsTime;
                bestIssue = {
                  id: iss.id,
                  issueNumber: iss.issueNumber ?? undefined,
                  title: iss.title,
                  workspaceId: ws.id,
                };
              }
            }
          }
        }
      }
      addNotificationBoardEvent(reason, bestIssue);
    }

    if (creatingInColumnId) {
      pendingBoardRefreshRef.current = true;
      return;
    }
    scheduleRefetch();
  }, [refetchBoard, scheduleRefetch, creatingInColumnId, addNotificationBoardEvent, columnsRef, loadProjectsRef, pendingBoardRefreshRef, setColumns]);

  const handleSessionActivity = useCallback((issueId: string, sessionId: string, activity: string) => {
    const isActive = columnsRef.current.some(col =>
      col.issues.some(iss => iss.id === issueId && (iss.workspaceSummary?.main?.status === "active" || iss.workspaceSummary?.main?.status === "fixing"))
    );
    if (!isActive) {
      setSessionActivityRaw((prev) => {
        if (!(issueId in prev)) return prev;
        const next = { ...prev };
        delete next[issueId];
        setLiveStats((prev2) => {
          if (!(issueId in prev2)) return prev2;
          const next2 = { ...prev2 };
          delete next2[issueId];
          return next2;
        });
        return next;
      });
      return;
    }
    setSessionActivityRaw((prev) => {
      const sessions = { ...(prev[issueId] ?? {}) };
      if (!activity) {
        delete sessions[sessionId];
      } else {
        if (sessions[sessionId] === activity) return prev;
        sessions[sessionId] = activity;
      }
      if (Object.keys(sessions).length === 0) {
        const next = { ...prev };
        delete next[issueId];
        setLiveStats((prev) => {
          if (!(issueId in prev)) return prev;
          const next = { ...prev };
          delete next[issueId];
          return next;
        });
        return next;
      }
      return { ...prev, [issueId]: sessions };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSessionStats = useCallback((issueId: string, stats: LiveSessionStats) => {
    const isActive = columnsRef.current.some(col =>
      col.issues.some(iss => iss.id === issueId && (iss.workspaceSummary?.main?.status === "active" || iss.workspaceSummary?.main?.status === "fixing"))
    );
    if (!isActive) return;
    setLiveStats((prev) => {
      if (prev[issueId]?.model === stats.model && prev[issueId]?.contextTokens === stats.contextTokens && prev[issueId]?.toolUses === stats.toolUses && prev[issueId]?.subagentCount === stats.subagentCount) return prev;
      return { ...prev, [issueId]: stats };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSessionTodos = useCallback((issueId: string, todos: TodoItem[]) => {
    setSessionTodos((prev) => ({ ...prev, [issueId]: todos }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleApprovalRequested = useCallback((req: ApprovalRequest) => {
    setApprovalRequests((prev) => [...prev, req]);
    let approvalIssue: NotificationIssue | undefined;
    if (req.workspaceId) {
      for (const col of columnsRef.current) {
        const iss = col.issues.find((i) => i.workspaceSummary?.main?.id === req.workspaceId);
        if (iss) {
          approvalIssue = { id: iss.id, issueNumber: iss.issueNumber ?? undefined, title: iss.title };
          break;
        }
      }
    }
    addNotificationApprovalEvent(req.workspaceId ?? req.sessionId, approvalIssue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addNotificationApprovalEvent]);

  useBoardEvents(activeProjectId, handleBoardChange, handleSessionActivity, handleSessionStats, handleSessionTodos, handleApprovalRequested);
}
