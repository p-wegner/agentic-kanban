import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type {
  DependencyInfo,
  IssueWithStatus,
  StatusWithIssues,
  UpdateIssueRequest,
} from "@agentic-kanban/shared";
import { apiFetch, apiPatch } from "../lib/api.js";
import { setBoardDragData, getBoardDragData } from "../lib/dragData.js";
import { applyLocalReorder, moveIssueToStatus } from "../lib/issueMoveHelpers.js";
import { showToast } from "../components/Toast.js";

/** Statuses whose name marks an issue as archived (terminal). Mirrors BoardPage. */
const ARCHIVE_STATUS_NAMES = new Set(["Done", "Cancelled"]);

type SwimlaneDimension = "none" | "priority" | "tag";

type MoveToDonePending = { issue: IssueWithStatus; confirm: () => Promise<void> } | null;
type DependencyImpactPending = {
  issue: IssueWithStatus;
  toStatusId: string;
  toStatusName: string;
  dependencies: DependencyInfo["dependencies"];
  confirm: () => Promise<void>;
} | null;

export interface UseBoardIssueMovementParams {
  /** Current-render board columns (read for optimistic snapshots). */
  columns: StatusWithIssues[];
  /** Live columns ref kept in sync with `setColumns` for deferred reads. */
  columnsRef: MutableRefObject<StatusWithIssues[]>;
  setColumns: Dispatch<SetStateAction<StatusWithIssues[]>>;
  activeProjectId: string | null;
  refetchBoard: (
    projectId?: string,
    options?: { force?: boolean },
  ) => Promise<StatusWithIssues[] | undefined>;
  /** Trailing-debounced board refetch used after optimistic updates. */
  scheduleRefetch: () => void;
  setMoveToDonePending: Dispatch<SetStateAction<MoveToDonePending>>;
  setDependencyImpactPending: Dispatch<SetStateAction<DependencyImpactPending>>;
}

export interface BoardIssueMovement {
  swimlaneDimension: SwimlaneDimension;
  handleSwimlaneChange: (dim: SwimlaneDimension) => void;
  handleBoardDragStart: (e: React.DragEvent, issue: IssueWithStatus) => void;
  handleDrop: (targetStatusId: string, sortOrder?: number) => Promise<void>;
  handleDropWithLane: (targetStatusId: string, laneKey: string, sortOrder?: number) => Promise<void>;
  handleColumnReorder: (columnId: string, newSortOrder: number) => Promise<void>;
  handleMoveToNext: (issue: IssueWithStatus, nextStatusId: string) => Promise<void>;
  handlePromoteBacklogIssue: (issue: IssueWithStatus, targetStatus: StatusWithIssues) => Promise<void>;
  /** Optimistic local-only move (no PATCH); exposed for reuse by callers. */
  moveIssueLocally: (issue: IssueWithStatus, targetStatus: StatusWithIssues, sortOrder?: number) => void;
}

/**
 * Owns the board's drag-and-drop / issue-movement concern: optimistic moves with
 * exact-snapshot rollback, swimlane drops (status + lane priority), column reorder,
 * the keyboard "move to next" flow with its MoveToDone confirm gate and dependency
 * impact preview, and backlog promotion. Extracted verbatim from BoardPage to give
 * this sub-domain a single, testable seam (it held the file's highest-CC handlers).
 */
export function useBoardIssueMovement(params: UseBoardIssueMovementParams): BoardIssueMovement {
  const {
    columns,
    columnsRef,
    setColumns,
    activeProjectId,
    refetchBoard,
    scheduleRefetch,
    setMoveToDonePending,
    setDependencyImpactPending,
  } = params;

  const [swimlaneDimension, setSwimlaneDimension] = useState<SwimlaneDimension>(() => {
    try {
      return (localStorage.getItem("kanban-swimlane") as SwimlaneDimension) ?? "none";
    } catch {
      return "none";
    }
  });

  function moveIssueLocally(issue: IssueWithStatus, targetStatus: StatusWithIssues, sortOrder?: number) {
    const changedAt = new Date().toISOString();
    setColumns((prev) => {
      const next = moveIssueToStatus(prev, issue, targetStatus, changedAt, sortOrder);
      columnsRef.current = next;
      return next;
    });
  }

  function handleDragStart(e: React.DragEvent, issue: IssueWithStatus) {
    e.dataTransfer.setData("application/json", JSON.stringify({
      issueId: issue.id,
      sourceStatusId: issue.statusId,
    }));
    e.dataTransfer.effectAllowed = "move";
  }

  const handleBoardDragStart = useCallback((e: React.DragEvent, issue: IssueWithStatus) => {
    setBoardDragData({ issueId: issue.id, sourceStatusId: issue.statusId });
    handleDragStart(e, issue);
  }, []);

  function handleSwimlaneChange(dim: SwimlaneDimension) {
    setSwimlaneDimension(dim);
    try { localStorage.setItem("kanban-swimlane", dim); } catch {}
  }

  async function handleDropWithLane(targetStatusId: string, laneKey: string, sortOrder?: number) {
    const data = getBoardDragData();
    if (!data) return;
    const { issueId } = data;
    if (!issueId) return;

    const lanePriority = swimlaneDimension === "priority" && laneKey !== "ungrouped" ? laneKey : undefined;
    const updateBody: Record<string, unknown> = { statusId: targetStatusId };
    if (sortOrder !== undefined) updateBody.sortOrder = sortOrder;
    if (lanePriority !== undefined) updateBody.priority = lanePriority;

    // Optimistic lane drop (status + lane priority) with exact-snapshot rollback.
    const snapshotColumns = columns;
    const movedIssue = columns.flatMap((c) => c.issues).find((i) => i.id === issueId);
    const targetColumn = columns.find((col) => col.id === targetStatusId);
    let optimistic = false;
    if (movedIssue && targetColumn) {
      const changedAt = new Date().toISOString();
      setColumns((prev) => {
        let next = moveIssueToStatus(prev, movedIssue, targetColumn, changedAt, sortOrder);
        if (lanePriority !== undefined) {
          next = next.map((col) =>
            col.id !== targetColumn.id
              ? col
              : { ...col, issues: col.issues.map((i) => (i.id === issueId ? { ...i, priority: lanePriority } : i)) },
          );
        }
        columnsRef.current = next;
        return next;
      });
      optimistic = true;
    }

    try {
      await apiPatch(`/api/issues/${issueId}`, updateBody);
      if (optimistic) {
        scheduleRefetch();
      } else {
        await refetchBoard();
      }
    } catch {
      if (optimistic) {
        setColumns(snapshotColumns);
        columnsRef.current = snapshotColumns;
      }
      showToast("Failed to move issue", "error");
    }
  }

  async function handleDrop(targetStatusId: string, sortOrder?: number) {
    const data = getBoardDragData();
    const issueId = data?.issueId;
    const sourceStatusId = data?.sourceStatusId;

    if (!issueId) return;
    if (sourceStatusId === targetStatusId && sortOrder === undefined) return;

    const targetColumn = columns.find((col) => col.id === targetStatusId);
    const isArchiveTarget = targetColumn && ARCHIVE_STATUS_NAMES.has(targetColumn.name);

    if (isArchiveTarget) {
      const issue = columns.flatMap((c) => c.issues).find((i) => i.id === issueId);
      const ws = issue?.workspaceSummary?.main;
      if (issue && ws && ws.status !== "closed") {
        setMoveToDonePending({
          issue,
          confirm: async () => {
            const body: UpdateIssueRequest = { statusId: targetStatusId };
            if (sortOrder !== undefined) body.sortOrder = sortOrder;
            await apiPatch(`/api/issues/${issueId}`, body);
            await refetchBoard();
            setMoveToDonePending(null);
          },
        });
        return;
      }
    }

    const isReorder = sourceStatusId === targetStatusId && sortOrder !== undefined;
    const snapshotColumns = columns;
    const movedIssue = columns.flatMap((c) => c.issues).find((i) => i.id === issueId);
    let optimistic = false;
    if (isReorder) {
      const capturedIssueId = issueId;
      const capturedSortOrder = sortOrder;
      setColumns((prev) => applyLocalReorder(prev, targetStatusId, capturedIssueId, capturedSortOrder));
      optimistic = true;
    } else if (movedIssue && targetColumn) {
      // Optimistic cross-column move: the card lands in the target column
      // immediately; the PATCH + trailing coalesced refetch converge server
      // state behind it. (The MoveToDone confirm path above stays blocking.)
      moveIssueLocally(movedIssue, targetColumn, sortOrder);
      optimistic = true;
    }

    try {
      const body: UpdateIssueRequest = { statusId: targetStatusId };
      if (sortOrder !== undefined) body.sortOrder = sortOrder;
      await apiPatch(`/api/issues/${issueId}`, body);
      if (optimistic) {
        scheduleRefetch();
      } else {
        await refetchBoard();
      }
    } catch {
      if (optimistic) {
        setColumns(snapshotColumns);
        columnsRef.current = snapshotColumns;
      }
      showToast("Failed to move issue", "error");
    }
  }

  async function handleColumnReorder(columnId: string, newSortOrder: number) {
    const snapshot = columns;
    setColumns((prev) =>
      prev
        .map((col) => (col.id === columnId ? { ...col, sortOrder: newSortOrder } : col))
        .sort((a, b) => a.sortOrder - b.sortOrder),
    );
    try {
      await apiPatch(`/api/projects/${activeProjectId}/statuses/${columnId}`, { sortOrder: newSortOrder });
      await refetchBoard();
    } catch {
      setColumns(snapshot);
      showToast("Failed to reorder column", "error");
    }
  }

  async function handleMoveToNext(issue: IssueWithStatus, nextStatusId: string) {
    const targetColumn = columns.find((col) => col.id === nextStatusId);

    const doMove = async () => {
      const isArchiveTarget = targetColumn && ARCHIVE_STATUS_NAMES.has(targetColumn.name);
      if (isArchiveTarget) {
        const ws = issue.workspaceSummary?.main;
        if (ws && ws.status !== "closed") {
          // Intentionally blocking: MoveToDone is a confirm gate.
          setMoveToDonePending({
            issue,
            confirm: async () => {
              await apiPatch(`/api/issues/${issue.id}`, { statusId: nextStatusId });
              await refetchBoard();
              setMoveToDonePending(null);
            },
          });
          return;
        }
      }
      // Optimistic move with exact-snapshot rollback. doMove may run later
      // (after the dependency-impact confirm), so snapshot the live columns
      // ref rather than this handler's render-time closure.
      const snapshotColumns = columnsRef.current;
      let optimistic = false;
      if (targetColumn) {
        moveIssueLocally(issue, targetColumn);
        optimistic = true;
      }
      try {
        await apiPatch(`/api/issues/${issue.id}`, { statusId: nextStatusId });
        if (optimistic) {
          scheduleRefetch();
        } else {
          await refetchBoard();
        }
      } catch {
        if (optimistic) {
          setColumns(snapshotColumns);
          columnsRef.current = snapshotColumns;
        }
        showToast("Failed to move issue", "error");
      }
    };

    try {
      const depInfo = await apiFetch<DependencyInfo>(`/api/issues/${issue.id}/dependencies`);
      if (depInfo.dependencies.length > 0 && targetColumn) {
        setDependencyImpactPending({
          issue,
          toStatusId: nextStatusId,
          toStatusName: targetColumn.name,
          dependencies: depInfo.dependencies,
          confirm: async () => {
            setDependencyImpactPending(null);
            await doMove();
          },
        });
        return;
      }
    } catch {
      // If dependency fetch fails, proceed without the preview
    }

    await doMove();
  }

  async function handlePromoteBacklogIssue(issue: IssueWithStatus, targetStatus: StatusWithIssues) {
    moveIssueLocally(issue, targetStatus);
    try {
      await apiPatch(`/api/issues/${issue.id}`, { statusId: targetStatus.id });
    } catch (err) {
      await refetchBoard();
      throw err;
    }
  }

  return {
    swimlaneDimension,
    handleSwimlaneChange,
    handleBoardDragStart,
    handleDrop,
    handleDropWithLane,
    handleColumnReorder,
    handleMoveToNext,
    handlePromoteBacklogIssue,
    moveIssueLocally,
  };
}
