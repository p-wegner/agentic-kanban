import { useCallback, useEffect, useMemo } from "react";
import { apiPost, apiPatch } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { useBoardBulkSelectionStore } from "../stores/boardBulkSelectionStore.js";
import type { IssueWithStatus, UpdateIssueRequest } from "@agentic-kanban/shared";

const ARCHIVE_STATUS_NAMES = new Set(["Done", "Cancelled"]);

interface Tag {
  id: string;
  name: string;
  color: string | null;
}

/**
 * Bulk-selection orchestration on top of the boardBulkSelectionStore (#958).
 * The raw selection/pending state lives in the store (components subscribe to
 * it directly); this hook contributes the pieces that need board data — the
 * selected-issue resolution against the visible issues, the visibility prune,
 * and the async bulk mutations.
 */
export function useBoardBulkSelection(
  visibleKanbanIssues: IssueWithStatus[],
  allTags: Tag[],
  refetchBoard: () => Promise<unknown>,
) {
  const selectedBoardIssueIds = useBoardBulkSelectionStore((s) => s.selectedBoardIssueIds);
  const lastSelectedBoardIssueId = useBoardBulkSelectionStore((s) => s.lastSelectedBoardIssueId);
  const boardBulkUpdating = useBoardBulkSelectionStore((s) => s.boardBulkUpdating);
  // Zustand actions are stable references — safe to read once via getState().
  const {
    addToSelection,
    toggleSelection,
    clearSelection,
    rangeSelect: rangeSelectInStore,
    setSelectedBoardIssueIds,
    setBoardBulkUpdating,
  } = useBoardBulkSelectionStore.getState();

  const selectedBoardIssues = useMemo(() => {
    const byId = new Map(visibleKanbanIssues.map((issue) => [issue.id, issue]));
    return [...selectedBoardIssueIds].map((id) => byId.get(id)).filter((issue): issue is IssueWithStatus => !!issue);
  }, [visibleKanbanIssues, selectedBoardIssueIds]);

  const hasArchivedBoardSelection = selectedBoardIssues.some((issue) => ARCHIVE_STATUS_NAMES.has(issue.statusName));

  // Prune selection when issues scroll off-screen
  useEffect(() => {
    if (selectedBoardIssueIds.size === 0) return;
    const visibleIds = new Set(visibleKanbanIssues.map((issue) => issue.id));
    setSelectedBoardIssueIds((prev) => {
      const next = new Set([...prev].filter((id) => visibleIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visibleKanbanIssues, selectedBoardIssueIds.size, setSelectedBoardIssueIds]);

  const rangeSelect = useCallback((issueId: string) => {
    rangeSelectInStore(visibleKanbanIssues.map((item) => item.id), issueId);
  }, [visibleKanbanIssues, rangeSelectInStore]);

  const handleBoardBulkUpdate = useCallback(async (updates: UpdateIssueRequest, successLabel: string) => {
    if (hasArchivedBoardSelection) return;
    const ids = selectedBoardIssues.map((issue) => issue.id);
    if (ids.length === 0) return;
    setBoardBulkUpdating(true);
    try {
      const results = await Promise.allSettled(ids.map((id) =>
        apiPatch(`/api/issues/${id}`, updates)
      ));
      const failed = results.filter((result) => result.status === "rejected").length;
      const succeeded = ids.length - failed;
      if (failed === 0) {
        showToast(`${successLabel} for ${succeeded} issue${succeeded !== 1 ? "s" : ""}`, "success");
      } else {
        showToast(`${successLabel} for ${succeeded} issue${succeeded !== 1 ? "s" : ""}; ${failed} failed`, "error");
      }
      clearSelection();
      await refetchBoard();
    } finally {
      setBoardBulkUpdating(false);
    }
  }, [hasArchivedBoardSelection, selectedBoardIssues, clearSelection, refetchBoard, setBoardBulkUpdating]);

  const handleBoardBulkAddTag = useCallback(async (tagId: string) => {
    if (hasArchivedBoardSelection) return;
    const tag = allTags.find((candidate) => candidate.id === tagId);
    const ids = selectedBoardIssues.map((issue) => issue.id);
    if (!tag || ids.length === 0) return;
    setBoardBulkUpdating(true);
    try {
      const results = await Promise.allSettled(ids.map((id) =>
        apiPost(`/api/issues/${id}/tags`, { tagId })
      ));
      const failed = results.filter((result) => result.status === "rejected").length;
      const succeeded = ids.length - failed;
      if (failed === 0) {
        showToast(`Added tag "${tag.name}" to ${succeeded} issue${succeeded !== 1 ? "s" : ""}`, "success");
      } else {
        showToast(`Added tag to ${succeeded} issue${succeeded !== 1 ? "s" : ""}; ${failed} failed`, "error");
      }
      clearSelection();
      await refetchBoard();
    } finally {
      setBoardBulkUpdating(false);
    }
  }, [hasArchivedBoardSelection, allTags, selectedBoardIssues, clearSelection, refetchBoard, setBoardBulkUpdating]);

  const handleBoardContractCoupled = useCallback(async () => {
    if (hasArchivedBoardSelection) return;
    const ids = selectedBoardIssues.map((issue) => issue.id);
    if (ids.length < 2) return;
    setBoardBulkUpdating(true);
    try {
      const result = await apiPost<{ leadIssueId: string; memberIssueIds: string[]; added: number; removed: number }>(
        "/api/issues/contract-coupled",
        { issueIds: ids, leadIssueId: ids[0] },
      );
      showToast(
        `Contracted ${result.memberIssueIds.length} coupled issue${result.memberIssueIds.length !== 1 ? "s" : ""}`,
        "success",
      );
      clearSelection();
      await refetchBoard();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Contract coupled issues failed", "error");
    } finally {
      setBoardBulkUpdating(false);
    }
  }, [hasArchivedBoardSelection, selectedBoardIssues, clearSelection, refetchBoard, setBoardBulkUpdating]);

  return {
    selectedBoardIssueIds,
    setSelectedBoardIssueIds,
    lastSelectedBoardIssueId,
    boardBulkUpdating,
    selectedBoardIssues,
    hasArchivedBoardSelection,
    addToSelection,
    toggleSelection,
    rangeSelect,
    clearSelection,
    handleBoardBulkUpdate,
    handleBoardBulkAddTag,
    handleBoardContractCoupled,
  };
}
