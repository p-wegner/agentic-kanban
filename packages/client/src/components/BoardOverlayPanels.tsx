import type { Dispatch, RefObject, SetStateAction } from "react";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { QuickTasksPanel } from "./QuickTasksPanel.js";
import { CodemodPanel } from "./CodemodPanel.js";
import { AllWorkspacesPanel } from "./AllWorkspacesPanel.js";
import { WorkspaceLaunchFailuresPanel } from "./WorkspaceLaunchFailuresPanel.js";
import { CleanupQueuePanel } from "./CleanupQueuePanel.js";
import { FileContentionPanel } from "./FileContentionPanel.js";
import { TranscriptSearchPanel } from "./TranscriptSearchPanel.js";
import { MergeQueuePanel } from "./MergeQueuePanel.js";
import { RunQueueForecastPanel } from "./RunQueueForecastPanel.js";
import { AgentStartDryRunModal } from "./AgentStartDryRunModal.js";
import { WorktreeOverview } from "./WorktreeOverview.js";
import { ProjectHealthOverview } from "./ProjectHealthOverview.js";
import { CommandPalette } from "./CommandPalette.js";
import { ShortcutHelp } from "./ShortcutHelp.js";
import { CreateIssuePanel } from "./CreateIssuePanel.js";
import { ApprovalDialog } from "./ApprovalDialog.js";
import { MoveToDoneDialog } from "./MoveToDoneDialog.js";
import { DependencyImpactDialog } from "./DependencyImpactDialog.js";
import type { CreateIssueFormState } from "./CreateIssueForm.js";
import type { ApprovalRequest } from "../lib/useBoardEvents.js";
import type { MonitorStatus } from "./MonitorPopover.js";
import type {
  CreateIssueRequest,
  DependencyInfo,
  IssueWithStatus,
  ProfileSelection,
  StatusWithIssues,
  UpdateIssueRequest,
} from "@agentic-kanban/shared";
import type { ViewMode } from "../lib/viewRegistry.js";

interface Project {
  id: string;
  name: string;
  repoPath: string;
  repoName: string;
  defaultBranch: string | null;
  remoteUrl: string | null;
  setupScript?: string | null;
  setupEnabled?: boolean;
  setupBlocking?: boolean;
  symlinkEnabled?: boolean;
  symlinkDirs?: string | null;
}

interface Props {
  // Panel visibility
  showSettings: boolean;
  showQuickTasks: boolean;
  showCodemod: boolean;
  showAllWorkspaces: boolean;
  showLaunchFailures: boolean;
  showCleanupQueue: boolean;
  showFileContention: boolean;
  showTranscriptSearch: boolean;
  showMergeQueue: boolean;
  showRunQueueForecast: boolean;
  showWorktreeOverview: boolean;
  showProjectHealth: boolean;
  showCommandPalette: boolean;
  showShortcutHelp: boolean;

  // Panel close handlers
  onCloseSettings: () => void;
  onCloseQuickTasks: () => void;
  onCloseCodemod: () => void;
  onCloseAllWorkspaces: () => void;
  onCloseLaunchFailures: () => void;
  onCloseCleanupQueue: () => void;
  onCloseFileContention: () => void;
  onCloseTranscriptSearch: () => void;
  onCloseMergeQueue: () => void;
  onCloseRunQueueForecast: () => void;
  onCloseWorktreeOverview: () => void;
  onCloseProjectHealth: () => void;
  onCloseCommandPalette: () => void;
  onCloseShortcutHelp: () => void;

  // Shared data
  activeProjectId: string | null;
  columns: StatusWithIssues[];
  nudgeWipLimit: string;
  viewMode: ViewMode;
  columnsRef: RefObject<StatusWithIssues[]>;

  // Workspace flow
  workspaceIssue: IssueWithStatus | null;
  workspaceInitial: { workspaceId: string; sessionId: string } | null;
  workspaceOpenCreate: boolean;
  setWorkspaceIssue: (issue: IssueWithStatus | null) => void;
  setWorkspaceInitial: (v: { workspaceId: string; sessionId: string } | null) => void;
  setWorkspaceOpenCreate: (v: boolean) => void;

  // Issue detail
  selectedIssue: IssueWithStatus | null;
  setSelectedIssue: (issue: IssueWithStatus | null) => void;

  // Dry run
  dryRunIssue: IssueWithStatus | null;
  setDryRunIssue: (issue: IssueWithStatus | null) => void;
  handleStartWorkspace: (issue: IssueWithStatus) => void;

  // Approvals & dialogs
  approvalRequests: ApprovalRequest[];
  setApprovalRequests: Dispatch<SetStateAction<ApprovalRequest[]>>;
  moveToDonePending: { issue: IssueWithStatus; confirm: () => Promise<void> } | null;
  setMoveToDonePending: (v: null) => void;
  dependencyImpactPending: {
    issue: IssueWithStatus;
    toStatusId: string;
    toStatusName: string;
    dependencies: DependencyInfo["dependencies"];
    confirm: () => Promise<void>;
  } | null;
  setDependencyImpactPending: (v: null) => void;

  // Create issue panel
  expandedCreatePanel: { statusId: string; statusName: string; state: Partial<CreateIssueFormState> } | null;
  setExpandedCreatePanel: (v: { statusId: string; statusName: string; state: Partial<CreateIssueFormState> } | null) => void;
  backlogColumn: StatusWithIssues | undefined;
  activeColumns: StatusWithIssues[];
  handleCreateIssue: (data: CreateIssueRequest & { startWorkspace?: boolean; planMode?: boolean; profile?: ProfileSelection; model?: string; isDirect?: boolean; skillId?: string }) => Promise<void>;
  canStartWorkspace: boolean;

  // Callbacks
  refetchBoard: () => Promise<unknown>;
  handleProjectChange: (id: string) => Promise<void>;
  onSettingsReloaded: (s: Record<string, string>, monitorStatus: MonitorStatus | null) => void;
}

export function BoardOverlayPanels({
  showSettings,
  showQuickTasks,
  showCodemod,
  showAllWorkspaces,
  showLaunchFailures,
  showCleanupQueue,
  showFileContention,
  showTranscriptSearch,
  showMergeQueue,
  showRunQueueForecast,
  showWorktreeOverview,
  showProjectHealth,
  showCommandPalette,
  showShortcutHelp,
  onCloseSettings,
  onCloseQuickTasks,
  onCloseCodemod,
  onCloseAllWorkspaces,
  onCloseLaunchFailures,
  onCloseCleanupQueue,
  onCloseFileContention,
  onCloseTranscriptSearch,
  onCloseMergeQueue,
  onCloseRunQueueForecast,
  onCloseWorktreeOverview,
  onCloseProjectHealth,
  onCloseCommandPalette,
  onCloseShortcutHelp,
  activeProjectId,
  columns,
  nudgeWipLimit,
  viewMode,
  columnsRef,
  dryRunIssue,
  setDryRunIssue,
  handleStartWorkspace,
  approvalRequests,
  setApprovalRequests,
  moveToDonePending,
  setMoveToDonePending,
  dependencyImpactPending,
  setDependencyImpactPending,
  expandedCreatePanel,
  setExpandedCreatePanel,
  backlogColumn,
  activeColumns,
  handleCreateIssue,
  canStartWorkspace,
  refetchBoard,
  handleProjectChange,
  onSettingsReloaded,
  setWorkspaceIssue,
  setWorkspaceInitial,
  setWorkspaceOpenCreate,
  setSelectedIssue,
}: Props) {
  return (
    <>
      <ApprovalDialog
        requests={approvalRequests}
        onResolve={(id) => setApprovalRequests((prev) => prev.filter((r) => r.id !== id))}
      />
      {moveToDonePending && (
        <MoveToDoneDialog
          issue={moveToDonePending.issue}
          onConfirm={moveToDonePending.confirm}
          onCancel={() => setMoveToDonePending(null)}
        />
      )}
      {dependencyImpactPending && (
        <DependencyImpactDialog
          issueId={dependencyImpactPending.issue.id}
          fromStatusName={dependencyImpactPending.issue.statusName ?? ""}
          toStatusName={dependencyImpactPending.toStatusName}
          dependencies={dependencyImpactPending.dependencies}
          onConfirm={dependencyImpactPending.confirm}
          onCancel={() => setDependencyImpactPending(null)}
        />
      )}
      {showSettings && (
        <SettingsPanel
          onClose={() => {
            onCloseSettings();
            apiFetch<Record<string, string>>("/api/preferences/settings")
              .then(async (s) => {
                let monitorStatus = null;
                try {
                  monitorStatus = await apiFetch<MonitorStatus>("/api/internal/monitor-status");
                } catch { /* ignore */ }
                onSettingsReloaded(s, monitorStatus);
              })
              .catch(() => {});
          }}
          activeProjectId={activeProjectId}
        />
      )}
      {showQuickTasks && activeProjectId && (
        <QuickTasksPanel
          projectId={activeProjectId}
          onClose={onCloseQuickTasks}
          onLaunched={() => refetchBoard()}
        />
      )}
      {showCodemod && (
        <CodemodPanel
          onClose={onCloseCodemod}
          activeProjectId={activeProjectId}
        />
      )}
      {showAllWorkspaces && (
        <AllWorkspacesPanel
          columns={columns}
          activeProjectId={activeProjectId ?? null}
          onClose={onCloseAllWorkspaces}
          onIssueClick={(issue) => {
            setSelectedIssue(issue);
            onCloseAllWorkspaces();
          }}
          onRefresh={() => refetchBoard()}
        />
      )}
      {showLaunchFailures && (
        <WorkspaceLaunchFailuresPanel
          projectId={activeProjectId ?? null}
          onClose={onCloseLaunchFailures}
          onIssueClick={(issueId) => {
            const issue = columns.flatMap((c) => c.issues).find((i) => i.id === issueId);
            if (issue) {
              setSelectedIssue(issue);
              onCloseLaunchFailures();
            }
          }}
        />
      )}
      {showCleanupQueue && (
        <CleanupQueuePanel
          projectId={activeProjectId ?? null}
          onClose={onCloseCleanupQueue}
        />
      )}
      {showFileContention && (
        <FileContentionPanel
          activeProjectId={activeProjectId ?? null}
          onClose={onCloseFileContention}
        />
      )}
      {showTranscriptSearch && activeProjectId && (
        <TranscriptSearchPanel
          projectId={activeProjectId}
          onClose={onCloseTranscriptSearch}
          onNavigateToWorkspace={(issueId, workspaceId, sessionId) => {
            onCloseTranscriptSearch();
            const issue = columnsRef.current.flatMap((c) => c.issues).find((i) => i.id === issueId);
            if (issue) {
              setSelectedIssue(null);
              setWorkspaceIssue(issue);
              setWorkspaceOpenCreate(false);
              setWorkspaceInitial({ workspaceId, sessionId });
            } else {
              showToast("Issue not found on current board — try refreshing", "error");
            }
          }}
        />
      )}
      {showMergeQueue && activeProjectId && (
        <MergeQueuePanel
          columns={columns}
          projectId={activeProjectId}
          onClose={onCloseMergeQueue}
          onIssueClick={(issue) => {
            setSelectedIssue(issue);
            onCloseMergeQueue();
          }}
          onMerged={() => { refetchBoard(); }}
        />
      )}
      {showRunQueueForecast && (
        <RunQueueForecastPanel
          columns={columns}
          activeTarget={nudgeWipLimit}
          onClose={onCloseRunQueueForecast}
          onIssueClick={(issue) => {
            setSelectedIssue(issue);
            onCloseRunQueueForecast();
          }}
          onDryRun={(issue) => {
            onCloseRunQueueForecast();
            setDryRunIssue(issue);
          }}
        />
      )}
      {dryRunIssue && (
        <AgentStartDryRunModal
          issue={dryRunIssue}
          onClose={() => setDryRunIssue(null)}
          onStartWorkspace={(issue) => {
            setDryRunIssue(null);
            handleStartWorkspace(issue);
          }}
        />
      )}
      {showWorktreeOverview && activeProjectId && (
        <WorktreeOverview
          projectId={activeProjectId}
          onClose={onCloseWorktreeOverview}
          onIssueClick={(issueId: string) => {
            for (const col of columns) {
              const found = col.issues.find((i) => i.id === issueId);
              if (found) {
                setSelectedIssue(found);
                break;
              }
            }
            onCloseWorktreeOverview();
          }}
          onWorkspaceChange={() => refetchBoard()}
        />
      )}
      {showProjectHealth && (
        <ProjectHealthOverview
          activeProjectId={activeProjectId}
          onProjectChange={handleProjectChange}
          onClose={onCloseProjectHealth}
        />
      )}
      {showCommandPalette && (
        <CommandPalette onClose={onCloseCommandPalette} />
      )}
      {showShortcutHelp && (
        <ShortcutHelp onClose={onCloseShortcutHelp} currentView={viewMode} />
      )}
      {expandedCreatePanel && activeProjectId && (
        <CreateIssuePanel
          projectId={activeProjectId}
          statusId={expandedCreatePanel.statusId}
          statusName={expandedCreatePanel.statusName}
          availableStatuses={[
            ...(backlogColumn ? [{ id: backlogColumn.id, name: backlogColumn.name }] : []),
            ...activeColumns.map((c) => ({ id: c.id, name: c.name })),
          ]}
          initialState={expandedCreatePanel.state}
          onSubmit={handleCreateIssue}
          onClose={() => setExpandedCreatePanel(null)}
          canStartWorkspace={canStartWorkspace}
        />
      )}
    </>
  );
}
