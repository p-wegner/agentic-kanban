import type { Dispatch, SetStateAction } from "react";
import { useCallback, useMemo, useState } from "react";
import type { IssueWithStatus } from "@agentic-kanban/shared";

export interface BoardOverlayPanelProps {
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
  onCloseShortcutHelp: () => void;
  dryRunIssue: IssueWithStatus | null;
  setDryRunIssue: (issue: IssueWithStatus | null) => void;
}

export interface BoardPanelState {
  showSettings: boolean;
  showQuickTasks: boolean;
  showMergeQueue: boolean;
  showRunQueueForecast: boolean;
  showCodemod: boolean;
  showWorktreeOverview: boolean;
  showAllWorkspaces: boolean;
  showLaunchFailures: boolean;
  showCleanupQueue: boolean;
  showFileContention: boolean;
  showMultiRepoMonitor: boolean;
  showTranscriptSearch: boolean;
  showProjectHealth: boolean;
  showTimeReport: boolean;
  showCommandPalette: boolean;
  showShortcutHelp: boolean;
  showLiveActivityTicker: boolean;
  showStartWorkspacePicker: boolean;
  dryRunIssue: IssueWithStatus | null;
  setShowSettings: Dispatch<SetStateAction<boolean>>;
  setShowQuickTasks: Dispatch<SetStateAction<boolean>>;
  setShowMergeQueue: Dispatch<SetStateAction<boolean>>;
  setShowRunQueueForecast: Dispatch<SetStateAction<boolean>>;
  setShowCodemod: Dispatch<SetStateAction<boolean>>;
  setShowWorktreeOverview: Dispatch<SetStateAction<boolean>>;
  setShowAllWorkspaces: Dispatch<SetStateAction<boolean>>;
  setShowLaunchFailures: Dispatch<SetStateAction<boolean>>;
  setShowCleanupQueue: Dispatch<SetStateAction<boolean>>;
  setShowFileContention: Dispatch<SetStateAction<boolean>>;
  setShowMultiRepoMonitor: Dispatch<SetStateAction<boolean>>;
  setShowTranscriptSearch: Dispatch<SetStateAction<boolean>>;
  setShowProjectHealth: Dispatch<SetStateAction<boolean>>;
  setShowTimeReport: Dispatch<SetStateAction<boolean>>;
  setShowCommandPalette: Dispatch<SetStateAction<boolean>>;
  setShowShortcutHelp: Dispatch<SetStateAction<boolean>>;
  setShowLiveActivityTicker: Dispatch<SetStateAction<boolean>>;
  setShowStartWorkspacePicker: Dispatch<SetStateAction<boolean>>;
  setDryRunIssue: (issue: IssueWithStatus | null) => void;
  openStartWorkspacePicker: () => void;
  closeStartWorkspacePicker: () => void;
  closeTopPanel: () => boolean;
  overlayPanelProps: BoardOverlayPanelProps;
}

export function useBoardPanels(): BoardPanelState {
  const [showSettings, setShowSettings] = useState(false);
  const [showQuickTasks, setShowQuickTasks] = useState(false);
  const [showMergeQueue, setShowMergeQueue] = useState(false);
  const [showRunQueueForecast, setShowRunQueueForecast] = useState(false);
  const [showCodemod, setShowCodemod] = useState(false);
  const [showWorktreeOverview, setShowWorktreeOverview] = useState(false);
  const [showAllWorkspaces, setShowAllWorkspaces] = useState(false);
  const [showLaunchFailures, setShowLaunchFailures] = useState(false);
  const [showCleanupQueue, setShowCleanupQueue] = useState(false);
  const [showFileContention, setShowFileContention] = useState(false);
  const [showMultiRepoMonitor, setShowMultiRepoMonitor] = useState(false);
  const [showTranscriptSearch, setShowTranscriptSearch] = useState(false);
  const [showProjectHealth, setShowProjectHealth] = useState(false);
  const [showTimeReport, setShowTimeReport] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [showLiveActivityTicker, setShowLiveActivityTicker] = useState(false);
  const [showStartWorkspacePicker, setShowStartWorkspacePicker] = useState(false);
  const [dryRunIssue, setDryRunIssue] = useState<IssueWithStatus | null>(null);

  const closeTopPanel = useCallback(() => {
    if (showCommandPalette) { setShowCommandPalette(false); return true; }
    if (showAllWorkspaces) { setShowAllWorkspaces(false); return true; }
    if (showLiveActivityTicker) { setShowLiveActivityTicker(false); return true; }
    if (showLaunchFailures) { setShowLaunchFailures(false); return true; }
    if (showCleanupQueue) { setShowCleanupQueue(false); return true; }
    if (showFileContention) { setShowFileContention(false); return true; }
    if (showMultiRepoMonitor) { setShowMultiRepoMonitor(false); return true; }
    if (showWorktreeOverview) { setShowWorktreeOverview(false); return true; }
    if (showShortcutHelp) { setShowShortcutHelp(false); return true; }
    if (showQuickTasks) { setShowQuickTasks(false); return true; }
    if (showRunQueueForecast) { setShowRunQueueForecast(false); return true; }
    if (showCodemod) { setShowCodemod(false); return true; }
    if (showProjectHealth) { setShowProjectHealth(false); return true; }
    if (showTimeReport) { setShowTimeReport(false); return true; }
    return false;
  }, [
    showAllWorkspaces,
    showCleanupQueue,
    showCodemod,
    showCommandPalette,
    showFileContention,
    showLaunchFailures,
    showLiveActivityTicker,
    showMultiRepoMonitor,
    showProjectHealth,
    showQuickTasks,
    showRunQueueForecast,
    showShortcutHelp,
    showTimeReport,
    showWorktreeOverview,
  ]);

  const openStartWorkspacePicker = useCallback(() => setShowStartWorkspacePicker(true), []);
  const closeStartWorkspacePicker = useCallback(() => setShowStartWorkspacePicker(false), []);

  const overlayPanelProps = useMemo<BoardOverlayPanelProps>(() => ({
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
    onCloseSettings: () => setShowSettings(false),
    onCloseQuickTasks: () => setShowQuickTasks(false),
    onCloseCodemod: () => setShowCodemod(false),
    onCloseAllWorkspaces: () => setShowAllWorkspaces(false),
    onCloseLaunchFailures: () => setShowLaunchFailures(false),
    onCloseCleanupQueue: () => setShowCleanupQueue(false),
    onCloseFileContention: () => setShowFileContention(false),
    onCloseMultiRepoMonitor: () => setShowMultiRepoMonitor(false),
    onCloseTranscriptSearch: () => setShowTranscriptSearch(false),
    onCloseMergeQueue: () => setShowMergeQueue(false),
    onCloseRunQueueForecast: () => setShowRunQueueForecast(false),
    onCloseWorktreeOverview: () => setShowWorktreeOverview(false),
    onCloseProjectHealth: () => setShowProjectHealth(false),
    onCloseTimeReport: () => setShowTimeReport(false),
    onCloseCommandPalette: () => setShowCommandPalette(false),
    onCloseStartWorkspacePicker: closeStartWorkspacePicker,
    onCloseShortcutHelp: () => setShowShortcutHelp(false),
    dryRunIssue,
    setDryRunIssue,
  }), [
    closeStartWorkspacePicker,
    dryRunIssue,
    showAllWorkspaces,
    showCleanupQueue,
    showCodemod,
    showCommandPalette,
    showFileContention,
    showLaunchFailures,
    showMergeQueue,
    showMultiRepoMonitor,
    showProjectHealth,
    showQuickTasks,
    showRunQueueForecast,
    showSettings,
    showShortcutHelp,
    showStartWorkspacePicker,
    showTimeReport,
    showTranscriptSearch,
    showWorktreeOverview,
  ]);

  return {
    showSettings,
    showQuickTasks,
    showMergeQueue,
    showRunQueueForecast,
    showCodemod,
    showWorktreeOverview,
    showAllWorkspaces,
    showLaunchFailures,
    showCleanupQueue,
    showFileContention,
    showMultiRepoMonitor,
    showTranscriptSearch,
    showProjectHealth,
    showTimeReport,
    showCommandPalette,
    showShortcutHelp,
    showLiveActivityTicker,
    showStartWorkspacePicker,
    dryRunIssue,
    setShowSettings,
    setShowQuickTasks,
    setShowMergeQueue,
    setShowRunQueueForecast,
    setShowCodemod,
    setShowWorktreeOverview,
    setShowAllWorkspaces,
    setShowLaunchFailures,
    setShowCleanupQueue,
    setShowFileContention,
    setShowMultiRepoMonitor,
    setShowTranscriptSearch,
    setShowProjectHealth,
    setShowTimeReport,
    setShowCommandPalette,
    setShowShortcutHelp,
    setShowLiveActivityTicker,
    setShowStartWorkspacePicker,
    setDryRunIssue,
    openStartWorkspacePicker,
    closeStartWorkspacePicker,
    closeTopPanel,
    overlayPanelProps,
  };
}
