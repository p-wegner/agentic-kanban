// Issue-action handlers extracted from BoardPage (create/update/delete + the
// drag-to-agent-slot launch). Behaviour-preserving verbatim move; BoardPage
// destructures them with the same names so its render is unchanged.
import type { Dispatch, SetStateAction } from "react";
import { apiPost, apiPatch, apiDelete } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { getSettings } from "../lib/settingsStore.js";
import { suggestBranchName } from "@agentic-kanban/shared/lib/branch";
import { isAutoReviewEnabled } from "@agentic-kanban/shared/lib/auto-review-pref";
import { runCreateIssueFlow, type CreateIssuePayload } from "../lib/createIssueService.js";
import type { ExpandedCreatePanel } from "../lib/boardTypes.js";
import type { IssueWithStatus, UpdateIssueRequest, StatusWithIssues } from "@agentic-kanban/shared";
import { resolveWorkspaceLaunchDefaults } from "../lib/workspaceLaunchDefaults.js";
import {
  boardSelectionActions,
  captureWorkspaceAutoOpenSelection,
  openWorkspacePanelIfUndisturbed,
} from "../stores/boardSelectionStore.js";
import { boardBulkSelectionActions } from "../stores/boardBulkSelectionStore.js";
import { isPlanModePriority } from "../lib/priorityTraits.js";
import { isAgentRunningStatus } from "@agentic-kanban/shared/lib/workspace-liveness";

type Setter<T> = Dispatch<SetStateAction<T>>;

interface BoardIssueActionsDeps {
  activeProject: { id: string; repoPath?: string; defaultBranch?: string | null } | null;
  activeAgentsTarget?: number;
  columns: StatusWithIssues[];
  columnsRef: React.RefObject<StatusWithIssues[]>;
  pendingBoardRefreshRef: React.RefObject<boolean>;
  refetchBoard: (projectId?: string, options?: { force?: boolean }) => Promise<StatusWithIssues[] | undefined>;
  setColumns: Setter<StatusWithIssues[]>;
  setCreatingInColumnId: Setter<string | null>;
  setError: Setter<string | null>;
  setExpandedCreatePanel: Setter<ExpandedCreatePanel>;
  setMutating: Setter<boolean>;
}

export function createBoardIssueActions(deps: BoardIssueActionsDeps) {
  const {
    activeProject, activeAgentsTarget, columns, columnsRef, pendingBoardRefreshRef,
    refetchBoard, setColumns, setCreatingInColumnId, setError, setExpandedCreatePanel,
    setMutating,
  } = deps;
  const { setSelectedIssue, setWorkspaceInitial, setWorkspaceIssue } = boardSelectionActions;
  // Pending-indicator sets moved into the bulk-selection store (#958) — write
  // it directly instead of receiving injected setters from BoardPage.
  const { setPendingIssueIds, setPendingWorkspaceIssueIds } = boardBulkSelectionActions;
  async function handleCreateIssue(data: CreateIssuePayload) {
    // #973: snapshot before the create+launch round trip; the flow consults the
    // guard below only once it is about to open the workspace panel.
    const selectionBeforeCreate = captureWorkspaceAutoOpenSelection();
    await runCreateIssueFlow(data, {
      columns,
      columnsRef,
      pendingBoardRefreshRef,
      activeProject: activeProject ? { defaultBranch: activeProject.defaultBranch ?? null } : undefined,
      setMutating,
      setError,
      setColumns,
      setCreatingInColumnId,
      setExpandedCreatePanel,
      setPendingIssueIds,
      setPendingWorkspaceIssueIds,
      setWorkspaceIssue,
      setWorkspaceInitial,
      refetchBoard,
      // The issue did not exist when the snapshot was taken, so there is no
      // "already on this issue" case to allow — only "the user has not moved".
      shouldOpenWorkspacePanel: () => {
        const after = captureWorkspaceAutoOpenSelection();
        return (
          after.selectedIssueId === selectionBeforeCreate.selectedIssueId &&
          after.workspaceIssueId === selectionBeforeCreate.workspaceIssueId
        );
      },
    });
  }

  async function handleUpdateIssue(id: string, data: UpdateIssueRequest) {
    setMutating(true);
    setError(null);
    try {
      await apiPatch(`/api/issues/${id}`, data);
      await refetchBoard();
      showToast("Issue updated", "success");
    } catch {
      showToast("Failed to update issue", "error");
    } finally {
      setMutating(false);
    }
  }

  async function handleDeleteIssue(id: string) {
    setMutating(true);
    setError(null);
    try {
      await apiDelete(`/api/issues/${id}`);
      setSelectedIssue(null);
      await refetchBoard();
      showToast("Issue deleted", "success");
    } catch {
      showToast("Failed to delete issue", "error");
    } finally {
      setMutating(false);
    }
  }

  async function handleDropOnAgentSlot(issue: IssueWithStatus) {
    if (!activeProject) return;

    // Guard: reject if already at or over capacity
    const activeCount = columns
      .flatMap((col) => col.issues)
      .filter((i) => {
        const s = i.workspaceSummary?.main?.status;
        return isAgentRunningStatus(s);
      }).length;
    if (activeAgentsTarget !== undefined && activeCount >= activeAgentsTarget) {
      showToast(`Agent capacity reached (${activeAgentsTarget} active). Stop a running workspace first.`, "error");
      return;
    }

    setPendingWorkspaceIssueIds((prev: Set<string>) => new Set([...prev, issue.id]));
    // #973: remember where the user was BEFORE the launch round trip, so a panel
    // that pops open seconds later cannot land on top of something newer.
    const selectionBeforeLaunch = captureWorkspaceAutoOpenSelection();
    try {
      const s = await getSettings();
      const { provider, profileName, model } = resolveWorkspaceLaunchDefaults(s);

      const branch = suggestBranchName(issue);
      const body: Record<string, unknown> = {
        issueId: issue.id,
        branch,
        requiresReview: isAutoReviewEnabled(s.auto_review),
        planMode: isPlanModePriority(issue.priority),
        isDirect: false,
        profile: { provider, name: profileName },
      };
      if (model) body.model = model;

      const result = await apiPost<{ id: string; sessionId?: string }>("/api/workspaces", body);
      await refetchBoard();
      // Open the new workspace in the panel — unless the user moved on (#973).
      const opened = openWorkspacePanelIfUndisturbed(selectionBeforeLaunch, issue, {
        workspaceId: result.id,
        sessionId: result.sessionId ?? "",
      });
      if (!opened) {
        showToast(`Workspace started for #${issue.issueNumber ?? issue.title}`, "success");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to start workspace", "error");
    } finally {
      setPendingWorkspaceIssueIds((prev: Set<string>) => {
        const next = new Set(prev);
        next.delete(issue.id);
        return next;
      });
    }
  }

  return { handleCreateIssue, handleUpdateIssue, handleDeleteIssue, handleDropOnAgentSlot };
}
