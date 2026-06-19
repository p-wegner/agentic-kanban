import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { buildTicketChatPrompt } from "@agentic-kanban/shared";
import { showToast } from "../lib/toast.js";
import type { ViewMode } from "../lib/viewRegistry.js";

interface UseBoardPanelNavigationDeps {
  pendingIssueIds: Set<string>;
  columnsRef: React.RefObject<StatusWithIssues[]>;
  refetchBoard: (projectId?: string) => Promise<StatusWithIssues[] | undefined>;
  setSelectedIssue: (issue: IssueWithStatus | null) => void;
  setKeyboardCursorIssueId: (id: string | null) => void;
  setWorkspaceIssue: (issue: IssueWithStatus | null) => void;
  setWorkspaceOpenCreate: (open: boolean) => void;
  setWorkspaceInitialDiff: (v: boolean) => void;
  setWorkspaceInitial: (init: { workspaceId: string; sessionId: string } | null) => void;
  setButlerInitialPrompt: (prompt: string | null) => void;
  handleViewModeChange: (mode: ViewMode) => void;
}

/**
 * BoardPage's panel-opening handlers: click an issue (detail panel), manage
 * workspaces / open a diff / start a workspace / open a workspace by id (the
 * workspace panel), and "chat about this ticket" (butler). Extracted from
 * BoardPage; the page destructures these with the same names so its render and
 * the child props are unchanged.
 */
export function useBoardPanelNavigation(deps: UseBoardPanelNavigationDeps) {
  const {
    pendingIssueIds,
    columnsRef,
    refetchBoard,
    setSelectedIssue,
    setKeyboardCursorIssueId,
    setWorkspaceIssue,
    setWorkspaceOpenCreate,
    setWorkspaceInitialDiff,
    setWorkspaceInitial,
    setButlerInitialPrompt,
    handleViewModeChange,
  } = deps;

  function handleIssueClick(issue: IssueWithStatus) {
    if (pendingIssueIds.has(issue.id)) return;
    setSelectedIssue(issue);
    setKeyboardCursorIssueId(null);
  }

  function handleManageWorkspaces(issue: IssueWithStatus, workspaceId?: string, sessionId = "") {
    setSelectedIssue(null);
    setWorkspaceIssue(issue);
    setWorkspaceOpenCreate(false);
    setWorkspaceInitialDiff(false);
    if (workspaceId) {
      setWorkspaceInitial({ workspaceId, sessionId });
    }
  }

  function handleChatAboutTicket(issue: IssueWithStatus) {
    setButlerInitialPrompt(buildTicketChatPrompt({
      issueNumber: issue.issueNumber,
      title: issue.title,
      description: issue.description,
      statusName: issue.statusName,
      issueType: issue.issueType,
    }));
    setSelectedIssue(null);
    handleViewModeChange("butler");
  }

  function handleOpenDiff(issue: IssueWithStatus, workspaceId: string) {
    setSelectedIssue(null);
    setWorkspaceIssue(issue);
    setWorkspaceOpenCreate(false);
    setWorkspaceInitialDiff(true);
    setWorkspaceInitial({ workspaceId, sessionId: "" });
  }

  async function handleOpenWorkspaceById(workspaceId: string, issueId: string) {
    let issue = columnsRef.current.flatMap((c) => c.issues).find((i) => i.id === issueId);
    if (!issue) {
      const board = await refetchBoard();
      issue = (board ?? []).flatMap((c) => c.issues).find((i) => i.id === issueId);
    }
    if (!issue) {
      showToast("Issue is not visible on the current board", "error");
      return;
    }
    setSelectedIssue(null);
    setWorkspaceIssue(issue);
    setWorkspaceOpenCreate(false);
    setWorkspaceInitial({ workspaceId, sessionId: "" });
  }

  function handleStartWorkspace(issue: IssueWithStatus) {
    setSelectedIssue(null);
    setWorkspaceIssue(issue);
    setWorkspaceInitial(null);
    setWorkspaceOpenCreate(true);
  }

  return {
    handleIssueClick,
    handleManageWorkspaces,
    handleChatAboutTicket,
    handleOpenDiff,
    handleOpenWorkspaceById,
    handleStartWorkspace,
  };
}
