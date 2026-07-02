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
import type { ExpandedCreatePanel } from "../routes/BoardPage.js";
import type { IssueWithStatus, UpdateIssueRequest, StatusWithIssues } from "@agentic-kanban/shared";
import { resolveWorkspaceLaunchDefaults } from "../lib/workspaceLaunchDefaults.js";
import { boardSelectionActions } from "../stores/boardSelectionStore.js";

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
  setPendingIssueIds: Setter<Set<string>>;
  setPendingWorkspaceIssueIds: Setter<Set<string>>;
}

export function createBoardIssueActions(deps: BoardIssueActionsDeps) {
  const {
    activeProject, activeAgentsTarget, columns, columnsRef, pendingBoardRefreshRef,
    refetchBoard, setColumns, setCreatingInColumnId, setError, setExpandedCreatePanel,
    setMutating, setPendingIssueIds, setPendingWorkspaceIssueIds,
  } = deps;
  const { setSelectedIssue, setWorkspaceInitial, setWorkspaceIssue, setWorkspaceOpenCreate } =
    boardSelectionActions;
  async function handleCreateIssue(data: CreateIssuePayload) {
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
        return s === "active" || s === "fixing";
      }).length;
    if (activeAgentsTarget !== undefined && activeCount >= activeAgentsTarget) {
      showToast(`Agent capacity reached (${activeAgentsTarget} active). Stop a running workspace first.`, "error");
      return;
    }

    setPendingWorkspaceIssueIds((prev: Set<string>) => new Set([...prev, issue.id]));
    try {
      const s = await getSettings();
      const { provider, profileName, model } = resolveWorkspaceLaunchDefaults(s);

      const branch = suggestBranchName(issue);
      const body: Record<string, unknown> = {
        issueId: issue.id,
        branch,
        requiresReview: isAutoReviewEnabled(s.auto_review),
        planMode: issue.priority === "high" || issue.priority === "critical",
        isDirect: false,
        profile: { provider, name: profileName },
      };
      if (model) body.model = model;

      const result = await apiPost<{ id: string; sessionId?: string }>("/api/workspaces", body);
      await refetchBoard();
      // Open the new workspace in the panel
      setWorkspaceIssue(issue);
      setWorkspaceInitial({ workspaceId: result.id, sessionId: result.sessionId ?? "" });
      setWorkspaceOpenCreate(false);
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
