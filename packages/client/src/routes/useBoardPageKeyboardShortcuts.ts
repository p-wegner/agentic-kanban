import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { SHORTCUT_TO_VIEW, type ViewMode } from "../lib/viewRegistry.js";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import type { CreateIssueFormState } from "../components/CreateIssueForm.js";

type SetState<T> = Dispatch<SetStateAction<T>>;

interface BoardPageShortcutDeps {
  searchQuery: string;
  setSearchQuery: SetState<string>;
  viewMode: ViewMode;
  panels: {
    setShowCommandPalette: SetState<boolean>;
    setShowAllWorkspaces: SetState<boolean>;
    setShowLiveActivityTicker: SetState<boolean>;
    setShowLaunchFailures: SetState<boolean>;
    setShowCleanupQueue: SetState<boolean>;
    setShowFileContention: SetState<boolean>;
    setShowWorktreeOverview: SetState<boolean>;
    setShowShortcutHelp: SetState<boolean>;
    setShowTranscriptSearch: SetState<boolean>;
    setShowQuickTasks: SetState<boolean>;
    setShowRunQueueForecast: SetState<boolean>;
    setShowCodemod: SetState<boolean>;
    setShowProjectHealth: SetState<boolean>;
    setShowTimeReport: SetState<boolean>;
    showSettings: boolean;
    setShowSettings: (open: boolean) => void;
    showFileContention: boolean;
    showLaunchFailures: boolean;
    showWorktreeOverview: boolean;
    showCleanupQueue: boolean;
    showTranscriptSearch: boolean;
    showShortcutHelp: boolean;
    showProjectHealth: boolean;
    showTimeReport: boolean;
    showQuickTasks: boolean;
    showRunQueueForecast: boolean;
    showCodemod: boolean;
    showCommandPalette: boolean;
    showLiveActivityTicker: boolean;
    showAllWorkspaces: boolean;
  };
  selectedIssue: IssueWithStatus | null;
  setSelectedIssue: SetState<IssueWithStatus | null>;
  columns: StatusWithIssues[];
  activeColumns: StatusWithIssues[];
  filteredColumns: StatusWithIssues[];
  archiveColumns: StatusWithIssues[];
  archiveExpanded: boolean;
  keyboardCursorIssueIdRef: MutableRefObject<string | null>;
  setKeyboardCursorIssueId: SetState<string | null>;
  pendingGRef: MutableRefObject<boolean>;
  pendingGTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  handleViewModeChange: (mode: ViewMode) => void;
  handleIssueClick: (issue: IssueWithStatus) => void;
  setFocusMode: SetState<boolean>;
  setExpandedCreatePanel: SetState<{ statusId: string; statusName: string; state: Partial<CreateIssueFormState> } | null>;
  setCreatingInColumnId: SetState<string | null>;
}

export function useBoardPageKeyboardShortcuts(deps: BoardPageShortcutDeps) {
  const {
    searchQuery,
    setSearchQuery,
    viewMode,
    panels,
    selectedIssue,
    setSelectedIssue,
    columns,
    activeColumns,
    filteredColumns,
    archiveColumns,
    archiveExpanded,
    keyboardCursorIssueIdRef,
    setKeyboardCursorIssueId,
    pendingGRef,
    pendingGTimerRef,
    handleViewModeChange,
    handleIssueClick,
    setFocusMode,
    setExpandedCreatePanel,
    setCreatingInColumnId,
  } = deps;

  useEffect(() => {
    function isTextEntryTarget(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) return false;
      return target.tagName === "INPUT"
        || target.tagName === "TEXTAREA"
        || target.tagName === "SELECT"
        || target.isContentEditable
        || target.closest("[contenteditable='true']") !== null;
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "k" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        panels.setShowCommandPalette(true);
        return;
      }
      if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        const input = document.getElementById("search-input") as HTMLInputElement | null;
        if (input) {
          input.focus();
          requestAnimationFrame(() => {
            if (input.value === "/") {
              input.value = "";
              setSearchQuery("");
            }
          });
        }
      }
      if (e.key === "Escape") {
        if (panels.showCommandPalette) { panels.setShowCommandPalette(false); return; }
        if (panels.showAllWorkspaces) { panels.setShowAllWorkspaces(false); return; }
        if (panels.showLiveActivityTicker) { panels.setShowLiveActivityTicker(false); return; }
        if (panels.showLaunchFailures) { panels.setShowLaunchFailures(false); return; }
        if (panels.showCleanupQueue) { panels.setShowCleanupQueue(false); return; }
        if (panels.showFileContention) { panels.setShowFileContention(false); return; }
        if (panels.showWorktreeOverview) { panels.setShowWorktreeOverview(false); return; }
        if (panels.showShortcutHelp) { panels.setShowShortcutHelp(false); return; }
        if (panels.showQuickTasks) { panels.setShowQuickTasks(false); return; }
        if (panels.showRunQueueForecast) { panels.setShowRunQueueForecast(false); return; }
        if (panels.showCodemod) { panels.setShowCodemod(false); return; }
        if (panels.showProjectHealth) { panels.setShowProjectHealth(false); return; }
        if (panels.showTimeReport) { panels.setShowTimeReport(false); return; }
        if (selectedIssue) { setSelectedIssue(null); return; }
        if (keyboardCursorIssueIdRef.current) { setKeyboardCursorIssueId(null); return; }
        if (searchQuery) {
          setSearchQuery("");
          document.getElementById("search-input")?.blur();
        }
      }

      const isArrowKey = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key);
      const isVimNavKey = ["j", "k", "h", "l"].includes(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey;
      const vimNavActive = isVimNavKey && keyboardCursorIssueIdRef.current !== null;
      if ((isArrowKey && !e.ctrlKey && !e.metaKey && !e.altKey) || vimNavActive) {
        if (isTextEntryTarget(e.target)) return;
        const navColumns = viewMode === "kanban" ? [...activeColumns, ...(archiveExpanded ? archiveColumns : [])] : [];
        if (navColumns.length === 0) return;
        e.preventDefault();
        const cursorId = keyboardCursorIssueIdRef.current;
        let colIdx = -1;
        let issueIdx = -1;
        if (cursorId) {
          for (let c = 0; c < navColumns.length; c++) {
            const i = navColumns[c].issues.findIndex((issue) => issue.id === cursorId);
            if (i !== -1) { colIdx = c; issueIdx = i; break; }
          }
        }
        if (colIdx === -1) {
          const firstCol = navColumns.find((c) => c.issues.length > 0);
          if (!firstCol) return;
          setKeyboardCursorIssueId(firstCol.issues[0].id);
          return;
        }
        let newColIdx = colIdx;
        let newIssueIdx = issueIdx;
        if (e.key === "ArrowDown" || e.key === "j") {
          if (issueIdx < navColumns[colIdx].issues.length - 1) {
            newIssueIdx = issueIdx + 1;
          }
        } else if (e.key === "ArrowUp" || e.key === "k") {
          if (issueIdx > 0) {
            newIssueIdx = issueIdx - 1;
          }
        } else if (e.key === "ArrowRight" || e.key === "l") {
          for (let c = colIdx + 1; c < navColumns.length; c++) {
            if (navColumns[c].issues.length > 0) {
              newColIdx = c;
              newIssueIdx = Math.min(issueIdx, navColumns[c].issues.length - 1);
              break;
            }
          }
        } else if (e.key === "ArrowLeft" || e.key === "h") {
          for (let c = colIdx - 1; c >= 0; c--) {
            if (navColumns[c].issues.length > 0) {
              newColIdx = c;
              newIssueIdx = Math.min(issueIdx, navColumns[c].issues.length - 1);
              break;
            }
          }
        }
        const target = navColumns[newColIdx]?.issues[newIssueIdx];
        if (target) setKeyboardCursorIssueId(target.id);
        return;
      }

      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        const cursorId = keyboardCursorIssueIdRef.current;
        if (!cursorId) return;
        const issue = columns.flatMap((c) => c.issues).find((i) => i.id === cursorId);
        if (issue) {
          e.preventDefault();
          handleIssueClick(issue);
        }
        return;
      }

      if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        panels.setShowShortcutHelp((prev) => !prev);
      }

      if (e.key === "g" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        pendingGRef.current = true;
        if (pendingGTimerRef.current) clearTimeout(pendingGTimerRef.current);
        pendingGTimerRef.current = setTimeout(() => {
          if (pendingGRef.current) {
            pendingGRef.current = false;
            handleViewModeChange("graph");
          }
        }, 400);
        return;
      }

      if (e.key === "s" && pendingGRef.current && !e.ctrlKey && !e.metaKey && !e.altKey) {
        pendingGRef.current = false;
        if (pendingGTimerRef.current) { clearTimeout(pendingGTimerRef.current); pendingGTimerRef.current = null; }
        e.preventDefault();
        panels.setShowSettings(true);
        return;
      }

      if (SHORTCUT_TO_VIEW[e.key] && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        handleViewModeChange(SHORTCUT_TO_VIEW[e.key]);
        return;
      }

      if (e.key === "a" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        panels.setShowAllWorkspaces((prev) => !prev);
        return;
      }
      if (e.key === "h" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        panels.setShowFileContention((prev) => !prev);
        return;
      }
      if (e.key === "t" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        panels.setShowTranscriptSearch(true);
        return;
      }
      if (e.key === "q" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        panels.setShowQuickTasks((prev) => !prev);
        return;
      }
      if (e.key === "l" && !e.ctrlKey && !e.metaKey && !e.altKey && keyboardCursorIssueIdRef.current === null) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        panels.setShowLiveActivityTicker((prev) => !prev);
        return;
      }
      if (e.key === "x" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        panels.setShowCodemod((prev) => !prev);
        return;
      }
      if (e.key === "p" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        panels.setShowProjectHealth((prev) => !prev);
        return;
      }
      if (e.key === "V" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("voice-inbox-trigger"));
        return;
      }
      if (e.key === "f" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        setFocusMode((v) => {
          const next = !v;
          try { sessionStorage.setItem("board-focus-mode", next ? "1" : "0"); } catch { /* ignore */ }
          return next;
        });
        return;
      }
      if ((e.key === "c" || e.key === "w") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        const col = activeColumns[0] ?? filteredColumns[0] ?? columns[0];
        if (!col) return;
        if (e.key === "w") {
          setExpandedCreatePanel({ statusId: col.id, statusName: col.name, state: { startWorkspace: true } });
        } else {
          setCreatingInColumnId(col.id);
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    columns,
    activeColumns,
    archiveColumns,
    archiveExpanded,
    filteredColumns,
    handleIssueClick,
    handleViewModeChange,
    keyboardCursorIssueIdRef,
    pendingGRef,
    pendingGTimerRef,
    panels,
    searchQuery,
    selectedIssue,
    setCreatingInColumnId,
    setExpandedCreatePanel,
    setFocusMode,
    setKeyboardCursorIssueId,
    setSearchQuery,
    setSelectedIssue,
    viewMode,
  ]);
}
