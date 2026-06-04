import type { Dispatch, SetStateAction } from "react";
import { useState } from "react";
import type { IssueWithStatus } from "@agentic-kanban/shared";

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
  showTranscriptSearch: boolean;
  showProjectHealth: boolean;
  showTimeReport: boolean;
  showCommandPalette: boolean;
  showShortcutHelp: boolean;
  showLiveActivityTicker: boolean;
  dryRunIssue: IssueWithStatus | null;
  setShowSettings: (v: boolean) => void;
  setShowQuickTasks: (v: boolean) => void;
  setShowMergeQueue: (v: boolean) => void;
  setShowRunQueueForecast: (v: boolean) => void;
  setShowCodemod: Dispatch<SetStateAction<boolean>>;
  setShowWorktreeOverview: (v: boolean) => void;
  setShowAllWorkspaces: Dispatch<SetStateAction<boolean>>;
  setShowLaunchFailures: (v: boolean) => void;
  setShowCleanupQueue: (v: boolean) => void;
  setShowFileContention: Dispatch<SetStateAction<boolean>>;
  setShowTranscriptSearch: (v: boolean) => void;
  setShowProjectHealth: Dispatch<SetStateAction<boolean>>;
  setShowTimeReport: Dispatch<SetStateAction<boolean>>;
  setShowCommandPalette: (v: boolean) => void;
  setShowShortcutHelp: Dispatch<SetStateAction<boolean>>;
  setShowLiveActivityTicker: Dispatch<SetStateAction<boolean>>;
  setDryRunIssue: (issue: IssueWithStatus | null) => void;
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
  const [showTranscriptSearch, setShowTranscriptSearch] = useState(false);
  const [showProjectHealth, setShowProjectHealth] = useState(false);
  const [showTimeReport, setShowTimeReport] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [showLiveActivityTicker, setShowLiveActivityTicker] = useState(false);
  const [dryRunIssue, setDryRunIssue] = useState<IssueWithStatus | null>(null);

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
    showTranscriptSearch,
    showProjectHealth,
    showTimeReport,
    showCommandPalette,
    showShortcutHelp,
    showLiveActivityTicker,
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
    setShowTranscriptSearch,
    setShowProjectHealth,
    setShowTimeReport,
    setShowCommandPalette,
    setShowShortcutHelp,
    setShowLiveActivityTicker,
    setDryRunIssue,
  };
}
