import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  CreateIssueRequest,
  IssueWithStatus,
  ProfileSelection,
  StatusWithIssues,
} from "@agentic-kanban/shared";
import { apiPost } from "./api.js";
import { suggestBranchName } from "@agentic-kanban/shared/lib/branch";
import { showToast } from "../components/Toast.js";

/** Payload accepted by the board's create-issue flow (issue data plus optional workspace launch). */
export type CreateIssuePayload = CreateIssueRequest & {
  startWorkspace?: boolean;
  planMode?: boolean;
  profile?: ProfileSelection;
  model?: string;
  isDirect?: boolean;
  skillId?: string;
};

/** Everything the create-issue flow needs from BoardPage (current values, refs, state setters). */
export interface CreateIssueFlowDeps {
  columns: StatusWithIssues[];
  columnsRef: MutableRefObject<StatusWithIssues[]>;
  pendingBoardRefreshRef: MutableRefObject<boolean>;
  activeProject: { defaultBranch: string | null } | undefined;
  setMutating: (value: boolean) => void;
  setError: (value: string | null) => void;
  setColumns: Dispatch<SetStateAction<StatusWithIssues[]>>;
  setCreatingInColumnId: (value: string | null) => void;
  setExpandedCreatePanel: (value: null) => void;
  setPendingIssueIds: Dispatch<SetStateAction<Set<string>>>;
  setPendingWorkspaceIssueIds: Dispatch<SetStateAction<Set<string>>>;
  setWorkspaceIssue: (issue: IssueWithStatus) => void;
  setWorkspaceInitial: (value: { workspaceId: string; sessionId: string }) => void;
  refetchBoard: () => Promise<StatusWithIssues[] | undefined>;
}

/**
 * Create-issue orchestration: inserts an optimistic card, POSTs the issue,
 * optionally launches a workspace for it, and rolls the optimistic card back
 * on failure. Extracted verbatim from BoardPage's handleCreateIssue so the
 * flow can be exercised without React.
 */
export async function runCreateIssueFlow(data: CreateIssuePayload, deps: CreateIssueFlowDeps): Promise<void> {
  const {
    columns,
    columnsRef,
    pendingBoardRefreshRef,
    activeProject,
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
  } = deps;
  setMutating(true);
  setError(null);
  const { startWorkspace, planMode, profile, model, isDirect, skillId, ...issueData } = data;
  const tempIssueId = `pending-${Date.now()}`;
  const targetColumn = columnsRef.current.find((col) => col.id === issueData.statusId);
  const now = new Date().toISOString();
  if (targetColumn) {
    const optimisticIssue: IssueWithStatus = {
      id: tempIssueId,
      issueNumber: null,
      title: issueData.title,
      description: issueData.description ?? null,
      priority: issueData.priority ?? "medium",
      issueType: issueData.issueType ?? "task",
      sortOrder: (targetColumn.issues[0]?.sortOrder ?? 0) - 100,
      statusId: issueData.statusId,
      projectId: issueData.projectId,
      createdAt: now,
      updatedAt: now,
      statusChangedAt: null,
      statusName: targetColumn.name,
      skipAutoReview: issueData.skipAutoReview,
      estimate: issueData.estimate ?? null,
      dueDate: null,
      tags: [],
    };
    const withOptimisticIssue = columnsRef.current.map((col) =>
      col.id === issueData.statusId
        ? { ...col, issues: [optimisticIssue, ...col.issues] }
        : col,
    );
    setColumns(withOptimisticIssue);
    columnsRef.current = withOptimisticIssue;
    setPendingIssueIds((prev) => new Set([...prev, tempIssueId]));
    if (startWorkspace) {
      setPendingWorkspaceIssueIds((prev) => new Set([...prev, tempIssueId]));
    }
  }
  try {
    const created = await apiPost<{ id: string; issueNumber: number; title: string }>("/api/issues", issueData);
    setCreatingInColumnId(null);
    setExpandedCreatePanel(null);
    setPendingIssueIds((prev) => {
      const next = new Set(prev);
      next.delete(tempIssueId);
      return next;
    });
    setPendingWorkspaceIssueIds((prev) => {
      const next = new Set(prev);
      next.delete(tempIssueId);
      if (startWorkspace) next.add(created.id);
      return next;
    });
    const board = await refetchBoard();
    pendingBoardRefreshRef.current = false;

    if (startWorkspace && activeProject) {
      try {
        const branch = suggestBranchName({
          issueNumber: created.issueNumber,
          title: created.title,
        });
        const ws = await apiPost<{ id: string; sessionId?: string }>("/api/workspaces", {
            issueId: created.id,
            branch: isDirect ? undefined : branch,
            baseBranch: isDirect ? undefined : activeProject.defaultBranch ?? undefined,
            isDirect: isDirect || undefined,
            planMode: planMode || undefined,
            profile: profile || undefined,
            model: model || undefined,
            skillId: skillId || undefined,
          });
        let launchedBoard = board;
        try {
          launchedBoard = await refetchBoard();
          pendingBoardRefreshRef.current = false;
        } catch {
          // workspace created; later realtime/poll refresh reconciles the card
        }
        for (const col of launchedBoard ?? board ?? columns) {
          const found = col.issues.find((i) => i.id === created.id);
          if (found) {
            setWorkspaceIssue(found);
            if (ws.sessionId) {
              setWorkspaceInitial({ workspaceId: ws.id, sessionId: ws.sessionId });
            }
            break;
          }
        }
        showToast("Issue and workspace created", "success");
      } catch {
        setPendingWorkspaceIssueIds((prev) => {
          const next = new Set(prev);
          next.delete(created.id);
          return next;
        });
        showToast("Issue created, but workspace creation failed", "error");
      }
    } else {
      showToast("Issue created", "success");
    }
  } catch {
    setColumns((prev) => {
      const next = prev.map((col) => ({ ...col, issues: col.issues.filter((issue) => issue.id !== tempIssueId) }));
      columnsRef.current = next;
      return next;
    });
    setPendingIssueIds((prev) => {
      const next = new Set(prev);
      next.delete(tempIssueId);
      return next;
    });
    setPendingWorkspaceIssueIds((prev) => {
      const next = new Set(prev);
      next.delete(tempIssueId);
      return next;
    });
    showToast("Failed to create issue", "error");
  } finally {
    setMutating(false);
  }
}
