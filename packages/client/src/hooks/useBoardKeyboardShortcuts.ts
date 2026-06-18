import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { CreateIssueFormState } from "../components/CreateIssueForm.js";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { apiFetch, apiPost } from "../lib/api.js";
import { registerAction } from "../lib/actions.js";
import { SHORTCUT_TO_VIEW, VIEW_REGISTRY, type ViewMode } from "../lib/viewRegistry.js";
import { showToast } from "../components/Toast.js";
import type { BoardPanelState } from "./useBoardPanels.js";

export interface BoardKeyboardShortcutProject {
  id: string;
  name: string;
}

export interface BoardKeyboardShortcutState {
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
  projects: BoardKeyboardShortcutProject[];
  activeProjectId: string | null;
}

export interface BoardKeyboardShortcutActions {
  handleIssueClick: (issue: IssueWithStatus) => void;
  handleViewModeChange: (mode: ViewMode) => void;
  handleProjectChange: (id: string) => Promise<void>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  setKeyboardCursorIssueId: Dispatch<SetStateAction<string | null>>;
  setSelectedIssue: Dispatch<SetStateAction<IssueWithStatus | null>>;
  setFocusMode: Dispatch<SetStateAction<boolean>>;
  setExpandedCreatePanel: Dispatch<SetStateAction<{ statusId: string; statusName: string; state: Partial<CreateIssueFormState> } | null>>;
  setCreatingInColumnId: Dispatch<SetStateAction<string | null>>;
  panels: BoardPanelState;
}

export function useBoardKeyboardShortcuts(
  state: BoardKeyboardShortcutState,
  actions: BoardKeyboardShortcutActions,
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
        if (actions.panels.closeTopPanel()) return;
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

  useEffect(() => {
    const unregisters: (() => void)[] = [];

    unregisters.push(registerAction({
      id: "create-issue",
      label: "Create Issue",
      description: "Add a new issue to the board",
      icon: "+",
      shortcut: "c",
      category: "issue",
      handler: () => {
        const col = state.activeColumns[0] ?? state.filteredColumns[0] ?? state.columns[0];
        if (col) actions.setExpandedCreatePanel({ statusId: col.id, statusName: col.name, state: {} });
      },
    }));

    unregisters.push(registerAction({
      id: "create-issue-with-workspace",
      label: "New Issue + Start Workspace",
      shortcut: "w",
      category: "issue",
      handler: () => {
        const col = state.activeColumns[0] ?? state.filteredColumns[0] ?? state.columns[0];
        if (col) actions.setExpandedCreatePanel({ statusId: col.id, statusName: col.name, state: { startWorkspace: true } });
      },
    }));

    unregisters.push(registerAction({
      id: "start-workspace-for-issue",
      label: "Start Workspace for Issue…",
      description: "Fuzzy-pick an issue and start a workspace for it",
      icon: "▷",
      category: "issue",
      handler: actions.panels.openStartWorkspacePicker,
    }));

    for (const project of state.projects) {
      const isActive = project.id === state.activeProjectId;
      unregisters.push(registerAction({
        id: `switch-project-${project.id}`,
        label: `Switch project: ${project.name}${isActive ? " (current)" : ""}`,
        description: isActive ? "Current active project" : "Switch to this project",
        icon: isActive ? "✓" : "⇄",
        category: "navigation",
        handler: () => {
          if (isActive) {
            showToast(`"${project.name}" is already active`, "success");
            return;
          }
          actions.handleProjectChange(project.id);
        },
      }));
    }

    unregisters.push(registerAction({ id: "open-settings", label: "Open Settings", description: "Configure agent, preferences, and project settings", icon: "⚙", category: "settings", handler: () => actions.panels.setShowSettings(true) }));
    unregisters.push(registerAction({ id: "view-all-workspaces", label: "All Workspaces", description: "View all workspaces with status, diff stats, and session activity", icon: "⊞", category: "navigation", handler: () => actions.panels.setShowAllWorkspaces(true) }));
    unregisters.push(registerAction({ id: "view-cleanup-queue", label: "Cleanup Queue", description: "View closed workspaces with failed worktree cleanup warnings", icon: "🧹", category: "navigation", handler: () => actions.panels.setShowCleanupQueue(true) }));
    unregisters.push(registerAction({ id: "view-file-contention", label: "File Contention Heatmap", description: "Show which active workspaces touch the same files (merge-risk clusters)", icon: "⚡", category: "navigation", handler: () => actions.panels.setShowFileContention(true) }));
    unregisters.push(registerAction({ id: "search-transcripts", label: "Search Transcripts", description: "Search agent session transcripts across all workspaces", icon: "⏎", category: "navigation", handler: () => actions.panels.setShowTranscriptSearch(true) }));
    unregisters.push(registerAction({ id: "view-worktrees", label: "View Worktrees", description: "Inspect git worktrees and their diff stats", icon: "⎇", category: "navigation", handler: () => actions.panels.setShowWorktreeOverview(true) }));
    unregisters.push(registerAction({ id: "view-project-health", label: "Project Health Overview", description: "See all registered projects with issue counts and warning states", icon: "◎", shortcut: "p", category: "navigation", handler: () => actions.panels.setShowProjectHealth(true) }));
    unregisters.push(registerAction({ id: "search-issues", label: "Search Issues", description: "Filter issues by text or keyword", icon: "⌕", shortcut: "/", category: "board", handler: () => document.getElementById("search-input")?.focus() }));
    unregisters.push(registerAction({ id: "show-shortcuts", label: "Keyboard Shortcuts", description: "View all available keyboard shortcuts", icon: "?", shortcut: "?", category: "settings", handler: () => actions.panels.setShowShortcutHelp(true) }));
    unregisters.push(registerAction({ id: "open-quick-tasks", label: "Open Quick Tasks", description: "View installed skills and run custom agent tasks", icon: "⚡", shortcut: "q", category: "board", handler: () => actions.panels.setShowQuickTasks(true) }));
    unregisters.push(registerAction({ id: "run-queue-forecast", label: "Run Queue Forecast", description: "View active-agent capacity and the next likely starts", icon: "▥", category: "board", handler: () => actions.panels.setShowRunQueueForecast(true) }));
    unregisters.push(registerAction({ id: "open-codemod-factory", label: "Codemod Factory", description: "Describe a refactor in plain English — AI generates a ts-morph codemod", icon: "⚙", shortcut: "x", category: "board", handler: () => actions.panels.setShowCodemod(true) }));
    unregisters.push(registerAction({ id: "toggle-live-activity", label: "Live Activity Ticker", description: "Toggle compact stream of running agent output (l)", icon: "▶", shortcut: "l", category: "board", handler: () => actions.panels.setShowLiveActivityTicker((prev) => !prev) }));

    for (const view of VIEW_REGISTRY) {
      unregisters.push(registerAction({
        id: `view-${view.id}`,
        label: `Switch to ${view.label} View`,
        description: view.paletteDescription,
        icon: view.paletteIcon,
        shortcut: view.shortcut,
        category: "navigation",
        handler: () => actions.handleViewModeChange(view.id),
      }));
    }

    for (const col of state.columns) {
      unregisters.push(registerAction({
        id: `goto-${col.id}`,
        label: `Go to: ${col.name}`,
        description: `Scroll to the ${col.name} column`,
        category: "navigation",
        handler: () => {
          const el = document.getElementById(`column-${col.id}`);
          el?.scrollIntoView({ behavior: "smooth", inline: "center" });
        },
      }));
    }

    const allIssues = state.columns.flatMap((col) => col.issues);
    for (const issue of allIssues) {
      const ws = issue.workspaceSummary?.main;
      if (!ws) continue;

      if (ws.status === "active" || ws.status === "idle" || ws.status === "reviewing") {
        unregisters.push(registerAction({
          id: `review-workspace-${ws.id}`,
          label: `Review: #${issue.issueNumber} ${issue.title}`,
          description: "Trigger AI code review for this workspace",
          icon: "③",
          category: "issue",
          handler: async () => {
            try {
              await apiPost(`/api/workspaces/${ws.id}/review`);
              showToast("Review started", "success");
            } catch {
              showToast("Failed to start review", "error");
            }
          },
        }));
      }

      if (ws.status === "reviewing" || ws.status === "idle") {
        unregisters.push(registerAction({
          id: `merge-workspace-${ws.id}`,
          label: `Merge: #${issue.issueNumber} ${issue.title}`,
          description: "Merge this workspace branch into the base branch",
          icon: "⤵",
          category: "issue",
          handler: async () => {
            try {
              await apiPost(`/api/workspaces/${ws.id}/merge`);
              showToast("Merge started", "success");
            } catch {
              showToast("Failed to merge", "error");
            }
          },
        }));
      }
    }

    return () => unregisters.forEach((fn) => fn());
  }, [
    actions,
    state.activeColumns,
    state.activeProjectId,
    state.columns,
    state.filteredColumns,
    state.projects,
  ]);
}
