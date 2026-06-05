import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { CreateIssueFormState } from "../components/CreateIssueForm.js";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { SHORTCUT_TO_VIEW, type ViewMode } from "../lib/viewRegistry.js";
import type { BoardPanelState } from "./useBoardPanels.js";

export interface KeyboardShortcutState {
  columnsRef: RefObject<StatusWithIssues[]>;
  columns: StatusWithIssues[];
  filteredColumns: StatusWithIssues[];
  activeColumns: StatusWithIssues[];
  archiveColumns: StatusWithIssues[];
  archiveExpanded: boolean;
  viewMode: ViewMode;
  keyboardCursorIssueId: string | null;
  keyboardCursorIssueIdRef: RefObject<string | null>;
  searchQuery: string;
  selectedIssue: IssueWithStatus | null;
}

export interface KeyboardShortcutActions {
  handleIssueClick: (issue: IssueWithStatus) => void;
  handleViewModeChange: (mode: ViewMode) => void;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  setKeyboardCursorIssueId: Dispatch<SetStateAction<string | null>>;
  setSelectedIssue: Dispatch<SetStateAction<IssueWithStatus | null>>;
  setFocusMode: Dispatch<SetStateAction<boolean>>;
  setExpandedCreatePanel: Dispatch<SetStateAction<{ statusId: string; statusName: string; state: Partial<CreateIssueFormState> } | null>>;
  setCreatingInColumnId: Dispatch<SetStateAction<string | null>>;
  panels: BoardPanelState;
}

export function useKeyboardShortcuts(
  state: KeyboardShortcutState,
  actions: KeyboardShortcutActions,
) {
  useEffect(() => {
    function isTextEntryTarget(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) return false;
      return target.tagName === "INPUT"
        || target.tagName === "TEXTAREA"
        || target.tagName === "SELECT"
        || target.isContentEditable
        || target.closest("[contenteditable='true']") !== null;
    }

    let pendingGRef = false;
    let pendingGTimerRef: ReturnType<typeof setTimeout> | null = null;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "k" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        actions.panels.setShowCommandPalette(true);
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
              actions.setSearchQuery("");
            }
          });
        }
      }
      if (e.key === "Escape") {
        if (actions.panels.showCommandPalette) { actions.panels.setShowCommandPalette(false); return; }
        if (actions.panels.showAllWorkspaces) { actions.panels.setShowAllWorkspaces(false); return; }
        if (actions.panels.showLiveActivityTicker) { actions.panels.setShowLiveActivityTicker(false); return; }
        if (actions.panels.showLaunchFailures) { actions.panels.setShowLaunchFailures(false); return; }
        if (actions.panels.showCleanupQueue) { actions.panels.setShowCleanupQueue(false); return; }
        if (actions.panels.showFileContention) { actions.panels.setShowFileContention(false); return; }
        if (actions.panels.showWorktreeOverview) { actions.panels.setShowWorktreeOverview(false); return; }
        if (actions.panels.showShortcutHelp) { actions.panels.setShowShortcutHelp(false); return; }
        if (actions.panels.showQuickTasks) { actions.panels.setShowQuickTasks(false); return; }
        if (actions.panels.showRunQueueForecast) { actions.panels.setShowRunQueueForecast(false); return; }
        if (actions.panels.showCodemod) { actions.panels.setShowCodemod(false); return; }
        if (actions.panels.showProjectHealth) { actions.panels.setShowProjectHealth(false); return; }
        if (actions.panels.showTimeReport) { actions.panels.setShowTimeReport(false); return; }
        if (state.selectedIssue) { actions.setSelectedIssue(null); return; }
        if (state.keyboardCursorIssueIdRef.current) { actions.setKeyboardCursorIssueId(null); return; }
        if (state.searchQuery) {
          actions.setSearchQuery("");
          document.getElementById("search-input")?.blur();
        }
      }

      const isArrowKey = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key);
      const isVimNavKey = ["j", "k", "h", "l"].includes(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey;
      const vimNavActive = isVimNavKey && state.keyboardCursorIssueIdRef.current !== null;
      if ((isArrowKey && !e.ctrlKey && !e.metaKey && !e.altKey) || vimNavActive) {
        if (isTextEntryTarget(e.target)) return;
        const navColumns = state.viewMode === "kanban" ? [...state.activeColumns, ...(state.archiveExpanded ? state.archiveColumns : [])] : [];
        if (navColumns.length === 0) return;
        e.preventDefault();
        const cursorId = state.keyboardCursorIssueIdRef.current;
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
          actions.setKeyboardCursorIssueId(firstCol.issues[0].id);
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
        if (target) actions.setKeyboardCursorIssueId(target.id);
        return;
      }

      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        const cursorId = state.keyboardCursorIssueIdRef.current;
        if (!cursorId) return;
        const issue = state.columnsRef.current.flatMap((c) => c.issues).find((i) => i.id === cursorId);
        if (issue) {
          e.preventDefault();
          actions.handleIssueClick(issue);
        }
        return;
      }

      if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        actions.panels.setShowShortcutHelp((prev) => !prev);
      }

      if (e.key === "g" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        pendingGRef = true;
        if (pendingGTimerRef) clearTimeout(pendingGTimerRef);
        pendingGTimerRef = setTimeout(() => {
          if (pendingGRef) {
            pendingGRef = false;
            actions.handleViewModeChange("graph");
          }
        }, 400);
        return;
      }

      if (e.key === "s" && pendingGRef && !e.ctrlKey && !e.metaKey && !e.altKey) {
        pendingGRef = false;
        if (pendingGTimerRef) {
          clearTimeout(pendingGTimerRef);
          pendingGTimerRef = null;
        }
        e.preventDefault();
        actions.panels.setShowSettings(true);
        return;
      }

      if (SHORTCUT_TO_VIEW[e.key] && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        actions.handleViewModeChange(SHORTCUT_TO_VIEW[e.key]);
        return;
      }

      if (e.key === "a" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        actions.panels.setShowAllWorkspaces((prev) => !prev);
        return;
      }

      if (e.key === "h" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        actions.panels.setShowFileContention((prev) => !prev);
        return;
      }

      if (e.key === "t" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        actions.panels.setShowTranscriptSearch(true);
        return;
      }

      if (e.key === "q" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        actions.panels.setShowQuickTasks(true);
        return;
      }

      if (e.key === "l" && !e.ctrlKey && !e.metaKey && !e.altKey && state.keyboardCursorIssueIdRef.current === null) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        actions.panels.setShowLiveActivityTicker((prev) => !prev);
        return;
      }

      if (e.key === "x" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        actions.panels.setShowCodemod((prev) => !prev);
        return;
      }

      if (e.key === "p" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        actions.panels.setShowProjectHealth((prev) => !prev);
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
        actions.setFocusMode((v) => {
          const next = !v;
          try { sessionStorage.setItem("board-focus-mode", next ? "1" : "0"); } catch { /* ignore */ }
          return next;
        });
        return;
      }

      if ((e.key === "c" || e.key === "w") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        const col = state.activeColumns[0] ?? state.filteredColumns[0] ?? state.columns[0];
        if (!col) return;
        if (e.key === "w") {
          actions.setExpandedCreatePanel({ statusId: col.id, statusName: col.name, state: { startWorkspace: true } });
        } else {
          actions.setCreatingInColumnId(col.id);
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (pendingGTimerRef) clearTimeout(pendingGTimerRef);
    };
  }, [
    actions,
    state.columns,
    state.columnsRef,
    state.filteredColumns,
    state.activeColumns,
    state.archiveColumns,
    state.archiveExpanded,
    state.keyboardCursorIssueId,
    state.keyboardCursorIssueIdRef,
    state.selectedIssue,
    state.searchQuery,
    state.viewMode,
  ]);
}
