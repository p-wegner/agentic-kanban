// Misc board interaction handlers extracted from BoardPage (duplicate issue,
// @mention navigation, group collapse toggle, created-date drill-down filter).
// Behaviour-preserving verbatim move; BoardPage destructures them with the same
// names so its render is unchanged.
import { useCallback, useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import { apiPost } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import type { useTicketTrail } from "./useTicketTrail.js";
import type { ViewMode } from "../lib/viewRegistry.js";

type Setter<T> = Dispatch<SetStateAction<T>>;

interface BoardMiscHandlersDeps {
  selectedIssue: IssueWithStatus | null;
  keyboardCursorIssueId: string | null;
  ticketTrail: ReturnType<typeof useTicketTrail>;
  openIssueById: (id: string) => void;
  handleViewModeChange: (mode: ViewMode) => void;
  refetchBoard: (projectId?: string, options?: { force?: boolean }) => Promise<unknown>;
  setCollapsedGroups: Setter<Set<string>>;
  setCreatedDateFilter: Setter<string | null>;
}

export function useBoardMiscHandlers(deps: BoardMiscHandlersDeps) {
  const {
    selectedIssue, keyboardCursorIssueId, ticketTrail, openIssueById,
    handleViewModeChange, refetchBoard, setCollapsedGroups, setCreatedDateFilter,
  } = deps;
  async function handleDuplicateIssue(issue: IssueWithStatus) {
    try {
      const result = await apiPost<{ id: string; issueNumber: number; title: string }>(`/api/issues/${issue.id}/duplicate`);
      await refetchBoard();
      showToast(`Duplicated as #${result.issueNumber}`, "success");
      openIssueById(result.id);
    } catch {
      showToast("Failed to duplicate issue", "error");
    }
  }

  const handleMentionClick = useCallback(
    (issueId: string) => {
      openIssueById(issueId);
    },
    [openIssueById],
  );

  useEffect(() => {
    if (!selectedIssue) return;
    ticketTrail.visit({
      id: selectedIssue.id,
      number: selectedIssue.issueNumber ?? null,
      title: selectedIssue.title,
    });
  }, [selectedIssue?.id, selectedIssue?.issueNumber, selectedIssue?.title, ticketTrail.visit]);

  useEffect(() => {
    if (!keyboardCursorIssueId) return;
    const el = document.querySelector(`[aria-current="true"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [keyboardCursorIssueId]);

  function toggleGroup(group: string) {
    setCollapsedGroups((prev: Set<string>) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  }

  const handleCreatedDateDrilldown = useCallback((dateKey: string) => {
    setCreatedDateFilter(dateKey);
    handleViewModeChange("table");
  }, [handleViewModeChange]);

  return { handleDuplicateIssue, handleMentionClick, toggleGroup, handleCreatedDateDrilldown };
}
