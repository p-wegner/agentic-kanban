import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { CreateIssueFormState } from "../components/CreateIssueForm.js";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { apiPost } from "../lib/api.js";
import { registerAction } from "../lib/actions.js";
import { SHORTCUT_TO_VIEW, VIEW_REGISTRY, type ViewMode } from "../lib/viewRegistry.js";
import { computeNavTarget, type NavKey } from "../lib/boardKeyboardNav.js";
import { showToast } from "../lib/toast.js";
import type { BoardPanelState } from "./useBoardPanels.js";
import { useBoardSelectionStore } from "../stores/boardSelectionStore.js";

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
  projects: BoardKeyboardShortcutProject[];
  activeProjectId: string | null;
}

export interface BoardKeyboardShortcutActions {
  handleIssueClick: (issue: IssueWithStatus) => void;
  handleViewModeChange: (mode: ViewMode) => void;
  handleProjectChange: (id: string) => Promise<void>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  setKeyboardCursorIssueId: Dispatch<SetStateAction<string | null>>;
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

    // Declarative keymap for the uniform single-key shortcuts: each entry matches a
    // key (+ modifier predicate) and runs an action. The shared guard/preventDefault
    // wrapper lives in the dispatch loop in handleKeyDown, so adding a shortcut is a
    // one-line entry here instead of another bespoke if-block. The stateful chord
    // (g, g-then-s), cursor navigation, Escape, Enter, command palette, and the
    // dual-key c/w create binding stay as explicit handlers — they don't fit the
    // "match key → run, suppress in text fields" shape.
    const noMods = (e: KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey;
    const simpleBindings: { match: (e: KeyboardEvent) => boolean; run: (e: KeyboardEvent) => void }[] = [
      { match: (e) => e.key === "?" && !e.ctrlKey && !e.metaKey, run: () => actions.panels.setShowShortcutHelp((prev) => !prev) },
      { match: (e) => !!SHORTCUT_TO_VIEW[e.key] && noMods(e), run: (e) => actions.handleViewModeChange(SHORTCUT_TO_VIEW[e.key]) },
      { match: (e) => e.key === "a" && noMods(e), run: () => actions.panels.setShowAllWorkspaces((prev) => !prev) },
      { match: (e) => e.key === "h" && noMods(e), run: () => actions.panels.setShowFileContention((prev) => !prev) },
      { match: (e) => e.key === "t" && noMods(e), run: () => actions.panels.setShowTranscriptSearch(true) },
      { match: (e) => e.key === "q" && noMods(e), run: () => actions.panels.setShowQuickTasks(true) },
      { match: (e) => e.key === "l" && noMods(e) && state.keyboardCursorIssueIdRef.current === null, run: () => actions.panels.setShowLiveActivityTicker((prev) => !prev) },
      { match: (e) => e.key === "x" && noMods(e), run: () => actions.panels.setShowCodemod((prev) => !prev) },
      { match: (e) => e.key === "p" && noMods(e), run: () => actions.panels.setShowProjectHealth((prev) => !prev) },
      { match: (e) => e.key === "V" && e.shiftKey && noMods(e), run: () => window.dispatchEvent(new CustomEvent("voice-inbox-trigger")) },
      {
        match: (e) => e.key === "f" && noMods(e),
        run: () => actions.setFocusMode((v) => {
          const next = !v;
          try { sessionStorage.setItem("board-focus-mode", next ? "1" : "0"); } catch { /* ignore */ }
          return next;
        }),
      },
    ];

    // Each handler returns true when it consumed the event (the dispatch loop
    // stops). Order matters and mirrors the original linear if-chain exactly.
    // The simple, uniform single-key shortcuts live in `simpleBindings`; only
    // these stateful / multi-branch bindings need a bespoke handler.
    function tryCommandPalette(e: KeyboardEvent): boolean {
      if (e.key === "k" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        actions.panels.setShowCommandPalette(true);
        return true;
      }
      return false;
    }

    function trySearchFocus(e: KeyboardEvent): boolean {
      if (!(e.key === "/" && !e.ctrlKey && !e.metaKey)) return false;
      if (isTextEntryTarget(e.target)) return true;
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
      return true;
    }

    function tryEscape(e: KeyboardEvent): boolean {
      if (e.key !== "Escape") return false;
      if (actions.panels.closeTopPanel()) return true;
      const selStore = useBoardSelectionStore.getState();
      if (selStore.selectedIssue) { selStore.setSelectedIssue(null); return true; }
      if (state.keyboardCursorIssueIdRef.current) { actions.setKeyboardCursorIssueId(null); return true; }
      if (state.searchQuery) {
        actions.setSearchQuery("");
        document.getElementById("search-input")?.blur();
      }
      return true;
    }

    function tryNavigation(e: KeyboardEvent): boolean {
      const isArrowKey = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key);
      const isVimNavKey = ["j", "k", "h", "l"].includes(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey;
      const vimNavActive = isVimNavKey && state.keyboardCursorIssueIdRef.current !== null;
      if (!((isArrowKey && !e.ctrlKey && !e.metaKey && !e.altKey) || vimNavActive)) return false;
      if (isTextEntryTarget(e.target)) return true;
      const navColumns = state.viewMode === "kanban" ? [...state.activeColumns, ...(state.archiveExpanded ? state.archiveColumns : [])] : [];
      if (navColumns.length === 0) return true;
      e.preventDefault();
      const targetId = computeNavTarget(navColumns, state.keyboardCursorIssueIdRef.current, e.key as NavKey);
      if (targetId) actions.setKeyboardCursorIssueId(targetId);
      return true;
    }

    function tryEnter(e: KeyboardEvent): boolean {
      if (!(e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey)) return false;
      if (isTextEntryTarget(e.target)) return true;
      const cursorId = state.keyboardCursorIssueIdRef.current;
      if (!cursorId) return true;
      const issue = state.columnsRef.current.flatMap((c) => c.issues).find((i) => i.id === cursorId);
      if (issue) {
        e.preventDefault();
        actions.handleIssueClick(issue);
      }
      return true;
    }

    function tryGChord(e: KeyboardEvent): boolean {
      if (!(e.key === "g" && !e.ctrlKey && !e.metaKey && !e.altKey)) return false;
      if (isTextEntryTarget(e.target)) return true;
      e.preventDefault();
      pendingGRef = true;
      if (pendingGTimerRef) clearTimeout(pendingGTimerRef);
      pendingGTimerRef = setTimeout(() => {
        if (pendingGRef) {
          pendingGRef = false;
          actions.handleViewModeChange("graph");
        }
      }, 400);
      return true;
    }

    function trySChord(e: KeyboardEvent): boolean {
      if (!(e.key === "s" && pendingGRef && !e.ctrlKey && !e.metaKey && !e.altKey)) return false;
      pendingGRef = false;
      if (pendingGTimerRef) {
        clearTimeout(pendingGTimerRef);
        pendingGTimerRef = null;
      }
      e.preventDefault();
      actions.panels.setShowSettings(true);
      return true;
    }

    function trySimpleBindings(e: KeyboardEvent): boolean {
      for (const binding of simpleBindings) {
        if (binding.match(e)) {
          if (isTextEntryTarget(e.target)) return true;
          e.preventDefault();
          binding.run(e);
          return true;
        }
      }
      return false;
    }

    function tryCreate(e: KeyboardEvent): boolean {
      if (!((e.key === "c" || e.key === "w") && !e.ctrlKey && !e.metaKey && !e.altKey)) return false;
      if (isTextEntryTarget(e.target)) return true;
      e.preventDefault();
      const col = state.activeColumns[0] ?? state.filteredColumns[0] ?? state.columns[0];
      if (!col) return true;
      if (e.key === "w") {
        actions.setExpandedCreatePanel({ statusId: col.id, statusName: col.name, state: { startWorkspace: true } });
      } else {
        actions.setCreatingInColumnId(col.id);
      }
      return true;
    }

    const keyHandlers = [
      tryCommandPalette,
      trySearchFocus,
      tryEscape,
      tryNavigation,
      tryEnter,
      tryGChord,
      trySChord,
      trySimpleBindings,
      tryCreate,
    ];

    function handleKeyDown(e: KeyboardEvent) {
      for (const handler of keyHandlers) {
        if (handler(e)) return;
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
          void actions.handleProjectChange(project.id);
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
          handler: () => {
            void (async () => {
              try {
                await apiPost(`/api/workspaces/${ws.id}/review`);
                showToast("Review started", "success");
              } catch {
                showToast("Failed to start review", "error");
              }
            })();
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
          handler: () => {
            void (async () => {
              try {
                await apiPost(`/api/workspaces/${ws.id}/merge`);
                showToast("Merge started", "success");
              } catch {
                showToast("Failed to merge", "error");
              }
            })();
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
