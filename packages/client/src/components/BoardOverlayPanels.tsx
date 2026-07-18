import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import { apiFetch } from "../lib/api.js";
import { getSettings } from "../lib/settingsStore.js";
import { showToast } from "./Toast.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { QuickTasksPanel } from "./QuickTasksPanel.js";
import { CodemodPanel } from "./CodemodPanel.js";
import { AllWorkspacesPanel } from "./AllWorkspacesPanel.js";
import { WorkspaceLaunchFailuresPanel } from "./WorkspaceLaunchFailuresPanel.js";
import { CleanupQueuePanel } from "./CleanupQueuePanel.js";
import { FileContentionPanel } from "./FileContentionPanel.js";
import { MultiRepoMonitorPanel } from "./MultiRepoMonitorPanel.js";
import { TranscriptSearchPanel } from "./TranscriptSearchPanel.js";
import { SessionTranscriptPanel } from "./SessionTranscriptPanel.js";
import { MergeQueuePanel } from "./MergeQueuePanel.js";
import { RunQueueForecastPanel } from "./RunQueueForecastPanel.js";
import { AgentStartDryRunModal } from "./AgentStartDryRunModal.js";
import { WorktreeOverview } from "./WorktreeOverview.js";
import { ProjectHealthOverview } from "./ProjectHealthOverview.js";
import { TimeReportPanel } from "./TimeReportPanel.js";
import { CommandPalette } from "./CommandPalette.js";
import { StartWorkspacePicker } from "./StartWorkspacePicker.js";
import { ShortcutHelp } from "./ShortcutHelp.js";
import { CreateIssuePanel } from "./CreateIssuePanel.js";
import { ApprovalDialog } from "./ApprovalDialog.js";
import { MoveToDoneDialog } from "./MoveToDoneDialog.js";
import { DependencyImpactDialog } from "./DependencyImpactDialog.js";
import { boardSelectionActions } from "../stores/boardSelectionStore.js";
import type { CreateIssueFormState } from "./CreateIssueForm.js";
import type { ApprovalRequest } from "../lib/useBoardEvents.js";
import type { MonitorStatus } from "./MonitorPopover.js";
import type {
  CreateIssueRequest,
  DependencyInfo,
  IssueWithStatus,
  ProfileSelection,
  StatusWithIssues,
} from "@agentic-kanban/shared";
import type { ViewMode } from "../lib/viewRegistry.js";

interface Props {
  // Panel visibility
  showSettings: boolean;
  showQuickTasks: boolean;
  showCodemod: boolean;
  showAllWorkspaces: boolean;
  showLaunchFailures: boolean;
  showCleanupQueue: boolean;
  showFileContention: boolean;
  showMultiRepoMonitor: boolean;
  showTranscriptSearch: boolean;
  showMergeQueue: boolean;
  showRunQueueForecast: boolean;
  showWorktreeOverview: boolean;
  showProjectHealth: boolean;
  showTimeReport: boolean;
  showCommandPalette: boolean;
  showStartWorkspacePicker: boolean;
  showShortcutHelp: boolean;

  // Panel close handlers
  onCloseSettings: () => void;
  onCloseQuickTasks: () => void;
  onCloseCodemod: () => void;
  onCloseAllWorkspaces: () => void;
  onCloseLaunchFailures: () => void;
  onCloseCleanupQueue: () => void;
  onCloseFileContention: () => void;
  onCloseMultiRepoMonitor: () => void;
  onCloseTranscriptSearch: () => void;
  onCloseMergeQueue: () => void;
  onCloseRunQueueForecast: () => void;
  onCloseWorktreeOverview: () => void;
  onCloseProjectHealth: () => void;
  onCloseTimeReport: () => void;
  onCloseCommandPalette: () => void;
  onCloseStartWorkspacePicker: () => void;
  onWorkspaceStarted: (workspaceId: string, issue: IssueWithStatus) => void;
  onCloseShortcutHelp: () => void;

  // Shared data
  activeProjectId: string | null;
  /** Leading repo path of the active project — used by the Multi-Repo Monitor (#82). */
  leadingRepoPath?: string | null;
  columns: StatusWithIssues[];
  nudgeWipLimit: string;
  viewMode: ViewMode;
  columnsRef: RefObject<StatusWithIssues[]>;

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
  /** Board filters + export/import, lifted off the toolbar into the Settings UI tab. */
  settingsBoardTools?: ReactNode;
}

export function BoardOverlayPanels({
  showSettings,
  showQuickTasks,
  showCodemod,
  showAllWorkspaces,
  showLaunchFailures,
  showCleanupQueue,
  showFileContention,
  showMultiRepoMonitor,
  showTranscriptSearch,
  showMergeQueue,
  showRunQueueForecast,
  showWorktreeOverview,
  showProjectHealth,
  showTimeReport,
  showCommandPalette,
  showStartWorkspacePicker,
  showShortcutHelp,
  onCloseSettings,
  onCloseQuickTasks,
  onCloseCodemod,
  onCloseAllWorkspaces,
  onCloseLaunchFailures,
  onCloseCleanupQueue,
  onCloseFileContention,
  onCloseMultiRepoMonitor,
  onCloseTranscriptSearch,
  onCloseMergeQueue,
  onCloseRunQueueForecast,
  onCloseWorktreeOverview,
  onCloseProjectHealth,
  onCloseTimeReport,
  onCloseCommandPalette,
  onCloseStartWorkspacePicker,
  onWorkspaceStarted,
  onCloseShortcutHelp,
  activeProjectId,
  leadingRepoPath,
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
  settingsBoardTools,
}: Props) {
  const { setWorkspaceIssue, setWorkspaceInitial, setWorkspaceOpenCreate, setSelectedIssue } =
    boardSelectionActions;
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
            // SettingsPanel invalidates the settings store after a successful
            // save, so this re-read is fresh when anything changed and a cheap
            // cache hit when the panel was closed without saving.
            getSettings()
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
          boardToolsSlot={settingsBoardTools}
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
      {showMultiRepoMonitor && (
        <MultiRepoMonitorPanel
          activeProjectId={activeProjectId ?? null}
          leadingRepoPath={leadingRepoPath ?? null}
          columns={columns}
          onClose={onCloseMultiRepoMonitor}
          onOpenWorkspace={(workspaceId, issueId) => {
            const issue = columnsRef.current.flatMap((c) => c.issues).find((i) => i.id === issueId);
            if (issue) {
              onCloseMultiRepoMonitor();
              setSelectedIssue(null);
              setWorkspaceIssue(issue);
              setWorkspaceOpenCreate(false);
              setWorkspaceInitial({ workspaceId });
            } else {
              showToast("Issue not found on current board — try refreshing", "error");
            }
          }}
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
          onMerged={() => { void refetchBoard(); }}
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
      {showTimeReport && activeProjectId && (
        <TimeReportPanel
          projectId={activeProjectId}
          onClose={onCloseTimeReport}
        />
      )}
      {showCommandPalette && (
        <CommandPalette onClose={onCloseCommandPalette} />
      )}
      {showStartWorkspacePicker && (
        <StartWorkspacePicker
          issues={columns.flatMap((col) => col.issues)}
          onClose={onCloseStartWorkspacePicker}
          onStarted={onWorkspaceStarted}
        />
      )}
      {showShortcutHelp && (
        <ShortcutHelp onClose={onCloseShortcutHelp} currentView={viewMode} />
      )}
      {/* Full session transcript viewer — self-mounted; opened via the
          openSessionTranscript() window event from any launch site (#87). */}
      <SessionTranscriptPanel />
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
