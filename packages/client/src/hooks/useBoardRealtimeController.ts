import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { StatusWithIssues } from "@agentic-kanban/shared";
import { useBoardLiveHandlers } from "./useBoardLiveHandlers.js";
import { useBoardRefetch } from "./useBoardRefetch.js";
import {
  deriveInactiveIssueIds,
  prunePendingWorkspaceIssueIds,
  pruneRecordKeys,
} from "../lib/boardDataReconcile.js";
import { boardBulkSelectionActions } from "../stores/boardBulkSelectionStore.js";
import type { ApprovalRequest, LiveSessionStats, TodoItem } from "../lib/useBoardEvents.js";

type NotificationIssue = { id: string; issueNumber?: number; title?: string; workspaceId?: string };

interface BoardRealtimeControllerParams {
  activeProjectId: string | null;
  /** Current-render board columns (react-query owned) — drives live-session pruning. */
  columns: StatusWithIssues[];
  columnsRef: MutableRefObject<StatusWithIssues[]>;
  creatingInColumnId: string | null;
  loadProjectsRef: MutableRefObject<() => Promise<string | undefined>>;
  addNotificationApprovalEvent: (key: string, issue?: NotificationIssue) => void;
  addNotificationBoardEvent: (reason: string, issue?: NotificationIssue) => void;
  setColumns: Dispatch<SetStateAction<StatusWithIssues[]>>;
}

export function useBoardRealtimeController({
  activeProjectId,
  columns,
  columnsRef,
  creatingInColumnId,
  loadProjectsRef,
  addNotificationApprovalEvent,
  addNotificationBoardEvent,
  setColumns,
}: BoardRealtimeControllerParams) {
  const [sessionActivityRaw, setSessionActivityRaw] = useState<Record<string, Record<string, string>>>({});
  const sessionActivity = useMemo(() => {
    const derived: Record<string, string> = {};
    for (const [issueId, sessions] of Object.entries(sessionActivityRaw)) {
      const values = Object.values(sessions);
      const last = [...values].reverse().find((v: string) => v);
      if (last) derived[issueId] = last;
    }
    return derived;
  }, [sessionActivityRaw]);
  const [liveStats, setLiveStats] = useState<Record<string, LiveSessionStats>>({});
  const [sessionTodos, setSessionTodos] = useState<Record<string, TodoItem[]>>({});
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([]);
  const pendingBoardRefreshRef = useRef(false);

  const { refetchBoard, scheduleRefetch } = useBoardRefetch({ activeProjectId });

  // Prune live-session bookkeeping for now-inactive issues whenever the board
  // data changes. This used to live inside the refetch engine's apply step;
  // with react-query as the single owner it derives from the board query data,
  // so it stays correct no matter which path (fetch, WS invalidation, optimistic
  // mutation) updated the columns. The prune helpers return the same reference
  // when nothing changed, so this is a no-op re-render in the common case.
  useEffect(() => {
    const inactiveIssueIds = deriveInactiveIssueIds(columns);
    boardBulkSelectionActions.setPendingWorkspaceIssueIds((prev) => prunePendingWorkspaceIssueIds(prev, columns));
    if (inactiveIssueIds.size > 0) {
      setLiveStats((prev) => pruneRecordKeys(prev, inactiveIssueIds));
      setSessionActivityRaw((prev) => pruneRecordKeys(prev, inactiveIssueIds));
    }
  }, [columns]);

  useBoardLiveHandlers({
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
  });

  useEffect(() => {
    if (!creatingInColumnId && pendingBoardRefreshRef.current) {
      pendingBoardRefreshRef.current = false;
      void refetchBoard();
    }
  }, [creatingInColumnId, refetchBoard]);

  return {
    approvalRequests,
    liveStats,
    pendingBoardRefreshRef,
    refetchBoard,
    scheduleRefetch,
    sessionActivity,
    sessionTodos,
    setApprovalRequests,
  };
}
