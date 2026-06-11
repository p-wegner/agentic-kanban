import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { apiFetch } from "./api.js";
import { showToast } from "../components/Toast.js";

interface QuickUpdateTag {
  id: string;
  name: string;
  color: string | null;
}

export interface QuickUpdateHandlerDeps {
  columnsRef: MutableRefObject<StatusWithIssues[]>;
  setColumns: Dispatch<SetStateAction<StatusWithIssues[]>>;
  allTags: QuickUpdateTag[];
  refetchBoard: () => Promise<StatusWithIssues[] | undefined>;
}

/**
 * Quick-update handlers for the board's issue-card context menu (priority,
 * tags, pin). Each applies an optimistic update, persists via the API, and
 * rolls back on failure. Plain closures (no hooks) so they can be created
 * inline during render exactly like the function declarations they replace.
 */
export function createQuickUpdateHandlers({ columnsRef, setColumns, allTags, refetchBoard }: QuickUpdateHandlerDeps) {
  function applyOptimisticIssueUpdate(issueId: string, updater: (issue: IssueWithStatus) => IssueWithStatus) {
    setColumns((prev) => {
      const next = prev.map((col) => ({
        ...col,
        issues: col.issues.map((iss) => (iss.id === issueId ? updater(iss) : iss)),
      }));
      columnsRef.current = next;
      return next;
    });
  }

  async function handleQuickPriorityChange(issueId: string, priority: string) {
    const prev = columnsRef.current.flatMap((c) => c.issues).find((i) => i.id === issueId);
    applyOptimisticIssueUpdate(issueId, (iss) => ({ ...iss, priority }));
    try {
      await apiFetch(`/api/issues/${issueId}`, {
        method: "PATCH",
        body: JSON.stringify({ priority }),
      });
      await refetchBoard();
    } catch {
      if (prev) applyOptimisticIssueUpdate(issueId, () => prev);
      showToast("Failed to update priority", "error");
    }
  }

  async function handleQuickAddTag(issueId: string, tagId: string) {
    const tag = allTags.find((t) => t.id === tagId);
    if (!tag) return;
    applyOptimisticIssueUpdate(issueId, (iss) => ({
      ...iss,
      tags: [...(iss.tags ?? []), tag],
    }));
    try {
      await apiFetch(`/api/issues/${issueId}/tags`, {
        method: "POST",
        body: JSON.stringify({ tagId }),
      });
      await refetchBoard();
    } catch {
      applyOptimisticIssueUpdate(issueId, (iss) => ({
        ...iss,
        tags: (iss.tags ?? []).filter((t) => t.id !== tagId),
      }));
      showToast("Failed to add tag", "error");
    }
  }

  async function handleQuickRemoveTag(issueId: string, tagId: string) {
    applyOptimisticIssueUpdate(issueId, (iss) => ({
      ...iss,
      tags: (iss.tags ?? []).filter((t) => t.id !== tagId),
    }));
    try {
      await apiFetch(`/api/issues/${issueId}/tags/${tagId}`, { method: "DELETE" });
      await refetchBoard();
    } catch {
      const tag = allTags.find((t) => t.id === tagId);
      if (tag) {
        applyOptimisticIssueUpdate(issueId, (iss) => ({
          ...iss,
          tags: [...(iss.tags ?? []), tag],
        }));
      }
      showToast("Failed to remove tag", "error");
    }
  }

  async function handleQuickTogglePinned(issueId: string, pinned: boolean) {
    applyOptimisticIssueUpdate(issueId, (iss) => ({ ...iss, pinned }));
    try {
      await apiFetch(`/api/issues/${issueId}`, {
        method: "PATCH",
        body: JSON.stringify({ pinned }),
      });
    } catch {
      applyOptimisticIssueUpdate(issueId, (iss) => ({ ...iss, pinned: !pinned }));
      showToast("Failed to update pin", "error");
    }
  }

  return { handleQuickPriorityChange, handleQuickAddTag, handleQuickRemoveTag, handleQuickTogglePinned };
}
