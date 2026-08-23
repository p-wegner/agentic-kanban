import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { fetchProjectRepos, invalidateProjectRepos } from "../lib/projectReposQuery.js";
import { ProjectTabs } from "./ProjectTabs.js";
import { ProjectSelector } from "./ProjectSelector.js";
import { NotificationBell } from "./NotificationBell.js";
import { WaitingOnYouChip } from "./WaitingOnYouChip.js";
import { useInboxCountsByProject } from "../hooks/useInbox.js";
import type { NotificationEvent } from "../hooks/useActivityNotifications.js";
import { useBoardFilterStore } from "../stores/boardFilterStore.js";
import { apiDelete, apiPost } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import type { ProjectRepoResponse } from "@agentic-kanban/shared";
import { AddProjectModal } from "./AddProjectModal.js";
import { OnboardingWizard } from "./OnboardingWizard.js";
import { onboardingActions, useOnboardingStore } from "../stores/onboardingStore.js";
import { useOnboardingStatus } from "../hooks/useOnboardingStatus.js";
import { useDismissable } from "../hooks/useDismissable.js";

// #610: Layout's shape is the LOOSE list-item one, not the full record — kept as a
// distinct type rather than merged, since its callers pass partial rows.
import type { ProjectListItem as Project } from "../lib/projectTypes.js";
import { Icon } from "./Icon.js";
export type { Project };

interface LayoutProps {
  children: ReactNode;
  /**
   * Board controls hoisted INTO the header row on phone widths (#436). The board toolbar is
   * its own 44px band under the header; on a 390px screen those two bands cost ~93px before
   * any content. The caller decides (via useIsNarrow) whether to render its toolbar in place
   * or hand it here — one instance either way, so BoardToolbar's popovers never double up.
   */
  headerExtra?: ReactNode;
  projects?: Project[];
  activeProjectId?: string | null;
  onProjectChange?: (id: string) => void;
  onUnregisterProject?: (id: string) => Promise<void>;
  onArchiveProject?: (id: string) => Promise<void>;
  onUnarchiveProject?: (id: string) => Promise<void>;
  archivedProjects?: Project[];
  onRegisterProject?: (args: { repoPath?: string; cloneUrl?: string; gitignoreTemplate: string; generateReadme: boolean; additionalRepos?: string[] }) => Promise<void>;
  onCreateProject?: (name: string, path: string, gitignoreTemplate: string, generateReadme: boolean) => Promise<void>;
  priorityFilter?: string;
  onPriorityFilterChange?: (priority: string) => void;
  onAllWorkspacesClick?: () => void;
  onLaunchFailuresClick?: () => void;
  onWorktreeOverviewClick?: () => void;
  onProjectHealthClick?: () => void;
  onSettingsClick?: () => void;
  isDark?: boolean;
  onThemeToggle?: () => void;
  notificationEvents?: NotificationEvent[];
  notificationUnreadCount?: number;
  notificationOpen?: boolean;
  onNotificationOpen?: () => void;
  onNotificationClose?: () => void;
  onNotificationMarkRead?: () => void;
  onNotificationEventClick?: (event: NotificationEvent) => void;
}

export function Layout({
  children,
  headerExtra,
  projects = [],
  activeProjectId,
  onProjectChange,
  onUnregisterProject,
  onArchiveProject,
  onUnarchiveProject,
  archivedProjects = [],
  onRegisterProject,
  onCreateProject,
  priorityFilter: _priorityFilter = "",
  onPriorityFilterChange: _onPriorityFilterChange,
  onAllWorkspacesClick,
  onLaunchFailuresClick,
  onWorktreeOverviewClick,
  onProjectHealthClick,
  onSettingsClick,
  isDark,
  onThemeToggle,
  notificationEvents = [],
  notificationUnreadCount = 0,
  notificationOpen = false,
  onNotificationOpen,
  onNotificationClose,
  onNotificationMarkRead,
  onNotificationEventClick,
}: LayoutProps) {
  // Filter slice (#958): the header search box reads/writes the board filter
  // store directly instead of receiving searchQuery/onSearchChange props.
  const searchQuery = useBoardFilterStore((s) => s.searchQuery);
  const setSearchQuery = useBoardFilterStore((s) => s.setSearchQuery);
  // #411: which projects have something blocked on a human (shared /api/inbox poll).
  const inboxCounts = useInboxCountsByProject();
  const [showRegister, setShowRegister] = useState(false);
  const [confirmUnregister, setConfirmUnregister] = useState<Project | null>(null);
  const [unregistering, setUnregistering] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState<Project | null>(null);
  const [archiving, setArchiving] = useState(false);
  // "++" add-repo-to-current-project modal.
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [addRepoMode, setAddRepoMode] = useState<"path" | "clone" | "create">("path");
  const [addRepoInput, setAddRepoInput] = useState("");
  const [addingRepo, setAddingRepo] = useState(false);
  const [addRepoError, setAddRepoError] = useState<string | null>(null);
  // Additional (sibling) repos of the active project — powers the ++ button badge
  // and the manage-repositories modal (list + remove). The leading repo is not a
  // row here; it lives on the project's repoPath/repoName and is shown separately.
  const queryClient = useQueryClient();
  const [projectRepos, setProjectRepos] = useState<ProjectRepoResponse[]>([]);
  const [removingRepoId, setRemovingRepoId] = useState<string | null>(null);
  const [promotingRepoId, setPromotingRepoId] = useState<string | null>(null);
  // Below sm the utility icons (workspaces/failures/worktrees/theme/settings)
  // collapse into a single ⋯ menu so the header fits on one row.
  const [showUtilMenu, setShowUtilMenu] = useState(false);
  /** Mobile search is an icon until tapped (#435) — see the header. */
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const utilMenuRef = useRef<HTMLDivElement>(null);
  useDismissable(utilMenuRef, showUtilMenu, () => setShowUtilMenu(false));

  // Served from the shared repos cache (#403); `fresh: true` (after a mutation)
  // invalidates first so every cached consumer sees the change too.
  const loadProjectRepos = useCallback(async (projectId: string | null | undefined, opts?: { fresh?: boolean }) => {
    if (!projectId) {
      setProjectRepos([]);
      return;
    }
    try {
      if (opts?.fresh) await invalidateProjectRepos(queryClient, projectId);
      setProjectRepos(await fetchProjectRepos(queryClient, projectId));
    } catch {
      // non-fatal: badge/list just stays empty
    }
  }, [queryClient]);

  // Keep the sibling-repo count (button badge) in sync with the active project.
  useEffect(() => {
    void loadProjectRepos(activeProjectId);
  }, [activeProjectId, loadProjectRepos]);

  // #475: persistent "setup incomplete" affordance — the wizard otherwise only ever opens right
  // after register/create or from the command palette, so closing it once leaves no way back and
  // no signal that required steps (stack-profile, setup-verify-scripts) are still outstanding.
  const wizardProjectId = useOnboardingStore((s) => s.projectId);
  const { pendingRequiredCount, dismissed, refresh: refreshOnboardingStatus } = useOnboardingStatus(activeProjectId);
  const [dismissingOnboarding, setDismissingOnboarding] = useState(false);
  const prevWizardProjectIdRef = useRef<string | null>(null);
  useEffect(() => {
    // Refresh right after the wizard closes for the active project — apply/skip/dismiss inside
    // it can change the plan, and this component never sees those responses directly.
    if (prevWizardProjectIdRef.current && !wizardProjectId && prevWizardProjectIdRef.current === activeProjectId) {
      void refreshOnboardingStatus();
    }
    prevWizardProjectIdRef.current = wizardProjectId;
  }, [wizardProjectId, activeProjectId, refreshOnboardingStatus]);

  async function handleDismissOnboardingBanner() {
    if (!activeProjectId) return;
    setDismissingOnboarding(true);
    try {
      await apiPost(`/api/projects/${activeProjectId}/onboarding/dismiss`, {});
      await refreshOnboardingStatus();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to dismiss", "error");
    } finally {
      setDismissingOnboarding(false);
    }
  }

  async function handleAddRepoSubmit(e: React.FormEvent) {
    e.preventDefault();
    const value = addRepoInput.trim();
    if (!value || !activeProjectId) return;
    if (addRepoMode === "create" && /[/\\<>:"|?*\x00]/.test(value)) {
      setAddRepoError('Name cannot contain: / \\ < > : " | ? *');
      return;
    }
    setAddingRepo(true);
    setAddRepoError(null);
    try {
      const body =
        addRepoMode === "clone" ? { cloneUrl: value }
        : addRepoMode === "create" ? { createName: value }
        : { path: value };
      const r = await apiPost<{ error?: string; name?: string }>(`/api/projects/${activeProjectId}/repos`, body);
      if (r.error) throw new Error(r.error);
      // Stay open so multiple repos can be added and the new one appears in the list.
      setAddRepoInput("");
      await loadProjectRepos(activeProjectId, { fresh: true });
      showToast(`Added repo "${r.name ?? value}" to the project`, "success");
    } catch (err) {
      setAddRepoError(errorMessage(err));
    } finally {
      setAddingRepo(false);
    }
  }

  async function handleRemoveRepo(repo: ProjectRepoResponse) {
    if (!activeProjectId) return;
    if (!window.confirm(`Remove "${repo.name ?? repo.path}" from this project?\n\nThis detaches the repo from the project; the checkout on disk is left untouched.`)) {
      return;
    }
    setRemovingRepoId(repo.id);
    try {
      await apiDelete(`/api/projects/${activeProjectId}/repos/${repo.id}`);
      await loadProjectRepos(activeProjectId, { fresh: true });
      showToast(`Removed "${repo.name ?? repo.path}" from the project`, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to remove repo", "error");
    } finally {
      setRemovingRepoId(null);
    }
  }

  async function handleMakeLeading(repo: ProjectRepoResponse) {
    if (!activeProjectId) return;
    if (!window.confirm(`Make "${repo.name ?? repo.path}" the leading repo of this project?\n\nThe current leading repo becomes a sibling. Only allowed when no workspaces are open.`)) {
      return;
    }
    setPromotingRepoId(repo.id);
    try {
      await apiPost(`/api/projects/${activeProjectId}/repos/${repo.id}/promote`, {});
      // The project row's repoName changes; the WS "project_updated" broadcast reloads the
      // project list (leading display), and this refreshes the sibling list here.
      await loadProjectRepos(activeProjectId, { fresh: true });
      showToast(`"${repo.name ?? repo.path}" is now the leading repo`, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to change the leading repo", "error");
    } finally {
      setPromotingRepoId(null);
    }
  }

  function openAddRepo() {
    setAddRepoError(null);
    setAddRepoInput("");
    setAddRepoMode("path");
    setShowAddRepo(true);
    void loadProjectRepos(activeProjectId);
  }

  async function handleConfirmUnregister() {
    if (!confirmUnregister || !onUnregisterProject) return;
    setUnregistering(true);
    try {
      await onUnregisterProject(confirmUnregister.id);
    } finally {
      setUnregistering(false);
      setConfirmUnregister(null);
    }
  }

  async function handleConfirmArchive() {
    if (!confirmArchive || !onArchiveProject) return;
    setArchiving(true);
    try {
      await onArchiveProject(confirmArchive.id);
    } finally {
      setArchiving(false);
      setConfirmArchive(null);
    }
  }

  function openRegister() {
    setShowRegister(true);
  }

  return (
    <div className="h-screen flex flex-col bg-surface dark:bg-surface-dark">
      <header className="bg-surface-raised dark:bg-surface-raised-dark border-b border-black/[0.07] dark:border-white/10 px-2.5 py-0.5 sm:py-1.5 sm:px-3 shrink-0">
        {mobileSearchOpen && (
          <div className="sm:hidden flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <Icon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-gray-500" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </Icon>
              <input
                type="text"
                autoFocus
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search issues…"
                className="w-full pl-8 pr-3 py-2 min-h-11 text-base border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500"
              />
            </div>
            <button
              type="button"
              onClick={() => { setSearchQuery(""); setMobileSearchOpen(false); }}
              className="shrink-0 p-2.5 min-h-11 min-w-11 inline-flex items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
              aria-label="Close search"
            >
              &times;
            </button>
          </div>
        )}
        <div className={`${mobileSearchOpen ? "hidden sm:flex" : "flex"} min-w-0 items-center justify-between gap-2`}>
          <div className={`flex items-center gap-1.5 min-w-0 ${headerExtra ? "shrink" : "flex-1"}`}>
            <h1 className="wordmark hidden sm:block text-base lg:text-lg font-semibold text-ink dark:text-stone-100 shrink-0">
              Agentic Kanban
            </h1>
            {/* Pinned-project chips are an optional fast path; the selector remains the full project switcher. */}
            <div className="hidden sm:contents">
              <ProjectTabs
                projects={projects}
                activeProjectId={activeProjectId ?? null}
                onProjectChange={onProjectChange}
              />
            </div>
            <ProjectSelector
              projects={projects}
              activeProjectId={activeProjectId ?? null}
              onProjectChange={onProjectChange}
              waitingCounts={inboxCounts}
            />
            {/* #411: what the ACTIVE project needs from a human, in every view. */}
            <WaitingOnYouChip activeProjectId={activeProjectId ?? null} />
            {projects.length > 0 && onArchiveProject && (
              <button
                onClick={() => {
                  const active = projects.find((p) => p.id === activeProjectId) ?? projects[0];
                  setConfirmArchive(active);
                }}
                className="hidden sm:inline-flex p-2.5 sm:p-1 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 items-center justify-center text-gray-400 dark:text-gray-500 hover:text-amber-500 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
                title="Archive project"
              >
                <Icon className="h-4 w-4" d="M21 8v13H3V8M1 3h22v5H1zM10 12h4" />
              </button>
            )}
            {projects.length > 0 && onUnregisterProject && (
              <button
                onClick={() => {
                  const active = projects.find((p) => p.id === activeProjectId) ?? projects[0];
                  setConfirmUnregister(active);
                }}
                className="hidden sm:inline-flex p-2.5 sm:p-1 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 items-center justify-center text-gray-400 dark:text-gray-500 hover:text-red-500 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
                title="Unregister project"
              >
                <Icon
                  className="h-4 w-4"
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </button>
            )}
            <button
              onClick={openRegister}
              className="hidden sm:inline-flex p-2.5 sm:p-1 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 items-center justify-center text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
              title="Register project"
            >
              <Icon className="h-4 w-4" strokeWidth="2.5">
                <path d="M12 5v14M5 12h14" />
              </Icon>
            </button>
            {activeProjectId && (
              <button
                onClick={openAddRepo}
                className="relative hidden sm:inline-flex p-2.5 sm:p-1 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 items-center justify-center text-gray-400 dark:text-gray-500 hover:text-brand-600 dark:hover:text-brand-400 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
                title={projectRepos.length > 0
                  ? `Manage repositories (${projectRepos.length + 1} repos in this project)`
                  : "Add a repository to this project (multi-repo)"}
              >
                {/* two overlapped plus glyphs → "++" = add another repo to the current project */}
                <Icon className="h-4 w-4" strokeWidth="2.5">
                  <path d="M8 5v9M4 9.5h8M16 10v9M12 14.5h8" />
                </Icon>
                {projectRepos.length > 0 && (
                  <span
                    className="absolute -top-0.5 -right-0.5 min-w-[1rem] h-4 px-1 flex items-center justify-center rounded-full bg-brand-600 text-white text-[10px] font-semibold leading-none"
                    aria-label={`${projectRepos.length + 1} repos in this project`}
                  >
                    {projectRepos.length + 1}
                  </span>
                )}
              </button>
            )}
          </div>
          {headerExtra && (
            <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5 sm:hidden">{headerExtra}</div>
          )}
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            {/* Below sm the field is an ICON until tapped (#435): at w-28 it showed a truncated
                "Search i…" while eating a quarter of the header. Tapping expands it over the
                header row, which is the only place a real query field fits on a phone. */}
            <button
              type="button"
              onClick={() => setMobileSearchOpen(true)}
              className="sm:hidden p-2.5 min-h-11 min-w-11 inline-flex items-center justify-center text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
              title="Search issues"
              aria-label="Search issues"
            >
              <Icon className="h-5 w-5" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </Icon>
            </button>
            <div className="relative hidden sm:block">
              <Icon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-gray-500">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </Icon>
              <input
                id="search-input"
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder='Search issues... ("/")'
                className="pl-8 pr-3 py-2 sm:py-1.5 min-h-11 sm:min-h-0 text-base sm:text-sm border border-gray-300 dark:border-gray-600 rounded-md w-28 sm:w-36 md:w-44 lg:w-56 xl:w-64 focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-xs"
                >
                  &times;
                </button>
              )}
            </div>
            <div className="hidden sm:flex items-center gap-1.5">
            <button
              onClick={onAllWorkspacesClick}
              className="p-2.5 sm:p-1.5 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 inline-flex items-center justify-center text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
              title="All Workspaces"
            >
              <Icon className="h-5 w-5">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </Icon>
            </button>
            <button
              onClick={onLaunchFailuresClick}
              className="p-2.5 sm:p-1.5 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 inline-flex items-center justify-center text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
              title="Launch Failures"
            >
              <Icon className="h-5 w-5">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </Icon>
            </button>
            <button
              onClick={onWorktreeOverviewClick}
              className="p-2.5 sm:p-1.5 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 inline-flex items-center justify-center text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
              title="Worktrees"
            >
              <Icon className="h-5 w-5">
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </Icon>
            </button>
            <button
              onClick={onProjectHealthClick}
              className="p-2.5 sm:p-1.5 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 inline-flex items-center justify-center text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
              title="Project Health (p)"
            >
              <Icon className="h-5 w-5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </button>
            <button
              onClick={onThemeToggle}
              className="p-2.5 sm:p-1.5 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 inline-flex items-center justify-center text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
              title={isDark ? "Switch to light mode" : "Switch to dark mode"}
            >
              {isDark ? (
                <Icon className="h-5 w-5">
                  <circle cx="12" cy="12" r="5" />
                  <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                </Icon>
              ) : (
                <Icon className="h-5 w-5">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </Icon>
              )}
            </button>
            <button
              onClick={onSettingsClick}
              className="p-2.5 sm:p-1.5 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 inline-flex items-center justify-center text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
              title="Settings"
            >
              <Icon className="h-5 w-5">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </Icon>
            </button>
            </div>
            {/* The bell is the ONLY cross-project list of gates waiting on a human
                (GET /api/inbox), and it used to live inside the `hidden sm:flex` cluster
                above — so on a phone it was display:none and the ⋯ menu's "Notifications"
                row toggled a dropdown inside that hidden subtree, i.e. tapping it did
                nothing visible (#433). It renders at ALL widths now; only the other
                utility icons fold. */}
            <NotificationBell
              events={notificationEvents}
              unreadCount={notificationUnreadCount}
              isOpen={notificationOpen}
              onOpen={onNotificationOpen ?? (() => {})}
              onClose={onNotificationClose ?? (() => {})}
              onMarkRead={onNotificationMarkRead ?? (() => {})}
              onEventClick={onNotificationEventClick ?? (() => {})}
            />
            {/* < sm : all utility actions fold into one ⋯ menu */}
            <div className="relative sm:hidden" ref={utilMenuRef}>
              <button
                onClick={() => setShowUtilMenu((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={showUtilMenu}
                className="p-2.5 sm:p-1.5 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 inline-flex items-center justify-center text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
                title="More"
              >
                <Icon solid className="h-5 w-5">
                  <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
                </Icon>
              </button>
              {showUtilMenu && (
                <div role="menu" className="absolute right-0 top-full z-40 mt-1 w-48 rounded-md border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900">
                  {[
                    { label: "All Workspaces", onClick: onAllWorkspacesClick },
                    { label: "Launch Failures", onClick: onLaunchFailuresClick },
                    { label: "Worktrees", onClick: onWorktreeOverviewClick },
                    { label: "Project Health", onClick: onProjectHealthClick },
                    // Folded off the mobile header (#435) — but folded AWAY is not the same as
                    // removed, so they keep a route here. Archive/Unregister are last and still
                    // go through their existing confirm dialogs.
                    { label: "Register project", onClick: openRegister },
                    ...(projects.length > 0 ? [
                      { label: "Add repository", onClick: openAddRepo },
                      { label: "Archive project", onClick: () => setConfirmArchive(projects.find((p) => p.id === activeProjectId) ?? projects[0]) },
                      { label: "Unregister project", onClick: () => setConfirmUnregister(projects.find((p) => p.id === activeProjectId) ?? projects[0]) },
                    ] : []),
                    { label: isDark ? "Light mode" : "Dark mode", onClick: onThemeToggle },
                    { label: "Settings", onClick: onSettingsClick },
                  ].map((item) => (
                    <button
                      key={item.label}
                      role="menuitem"
                      onClick={() => { setShowUtilMenu(false); item.onClick?.(); }}
                      className="flex w-full items-center rounded px-2.5 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800"
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </header>
      {activeProjectId && !dismissed && pendingRequiredCount > 0 && (
        <div
          data-testid="onboarding-banner"
          className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-300"
        >
          <span>
            Setup incomplete — {pendingRequiredCount} required step{pendingRequiredCount === 1 ? "" : "s"} left.
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => onboardingActions.openOnboarding(activeProjectId, projects.find((p) => p.id === activeProjectId)?.name ?? "this project")}
              data-testid="onboarding-banner-continue"
              className="rounded bg-amber-600 px-2 py-0.5 font-medium text-white hover:bg-amber-700"
            >
              Finish setup
            </button>
            <button
              type="button"
              disabled={dismissingOnboarding}
              onClick={() => void handleDismissOnboardingBanner()}
              data-testid="onboarding-banner-dismiss"
              className="rounded border border-amber-300 dark:border-amber-700 px-2 py-0.5 hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      <main className="flex-1 min-h-0 overflow-hidden">{children}</main>

      {confirmUnregister && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-surface-raised dark:bg-surface-raised-dark rounded-lg shadow-xl w-full max-w-sm mx-4 p-6">
            <h2 className="text-lg font-semibold text-ink dark:text-stone-100 mb-2">Remove project?</h2>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-6">
              Remove <span className="font-medium">{confirmUnregister.name}</span> from the board? This does not delete the git repository.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmUnregister(null)}
                disabled={unregistering}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmUnregister}
                disabled={unregistering}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 disabled:opacity-50"
              >
                {unregistering ? "Removing..." : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmArchive && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-surface-raised dark:bg-surface-raised-dark rounded-lg shadow-xl w-full max-w-sm mx-4 p-6">
            <h2 className="text-lg font-semibold text-ink dark:text-stone-100 mb-2">Archive project?</h2>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-6">
              Archive <span className="font-medium">{confirmArchive.name}</span>? It will be hidden from the project list and its data is kept — restore it any time from the Add Project dialog.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmArchive(null)}
                disabled={archiving}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmArchive}
                disabled={archiving}
                className="px-4 py-2 text-sm font-medium text-white bg-amber-600 rounded-md hover:bg-amber-700 disabled:opacity-50"
              >
                {archiving ? "Archiving..." : "Archive"}
              </button>
            </div>
          </div>
        </div>
      )}

      <AddProjectModal
        open={showRegister}
        onClose={() => setShowRegister(false)}
        onRegisterProject={onRegisterProject}
        onCreateProject={onCreateProject}
        archivedProjects={archivedProjects}
        onUnarchiveProject={onUnarchiveProject}
      />

      {/* #464 — self-contained: it reads its target project from onboardingStore and its plan
          from the server, so mounting it costs nothing until something opens it. */}
      <OnboardingWizard />

      {showAddRepo && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowAddRepo(false); }}
        >
          {/* max-h + flex column: the repo list is the only part that grows with the project's
              repo count, so it is the only part that scrolls. Without this a 16-repo project
              (CoMET) rendered a 1160px modal in a 720px viewport — title clipped off the top,
              the whole "Add a repository" form off the bottom, and nothing scrollable. */}
          <div className="bg-surface-raised dark:bg-surface-raised-dark rounded-lg shadow-xl w-full max-w-md p-6 max-h-full flex flex-col">
            <h2 className="text-lg font-semibold text-ink dark:text-stone-100 mb-1 shrink-0">Repositories</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 shrink-0">
              Repos that{" "}
              <span className="font-medium">{projects.find((p) => p.id === activeProjectId)?.name ?? "this project"}</span>{" "}
              spans. Every new workspace gets a worktree on the same branch in each; merge lands each repo that has commits. Edit a repo's name/setup/compose in Settings → Project Settings.
            </p>
            {(() => {
              const activeProject = projects.find((p) => p.id === activeProjectId);
              return (
                <ul className="space-y-1 mb-4 flex-1 min-h-0 overflow-y-auto">
                  <li className="flex items-center justify-between gap-2 text-sm border border-gray-200 dark:border-gray-700 rounded px-2.5 py-1.5">
                    <div className="min-w-0">
                      <span className="font-medium">{activeProject?.repoName || activeProject?.repoPath || "leading repo"}</span>
                      {/* #635: the leading row showed no branch at all, which is exactly where
                          the interesting fact hid — on comet the leading repo is on
                          `board/agent-onboarding` while all 16 siblings are on `master`. A
                          project split across two base branches was invisible here. */}
                      {activeProject?.repoPath && (
                        <span className="flex items-baseline gap-1.5 text-xs">
                          <span
                            className="text-gray-500 font-mono truncate"
                            style={{ direction: "rtl", textAlign: "left" }}
                            title={activeProject.repoPath}
                          >
                            <bdi>{activeProject.repoPath}</bdi>
                          </span>
                          {activeProject.defaultBranch && (
                            <span
                              className="shrink-0 px-1 py-0 rounded font-mono text-[10px] bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                              title={`Base branch: ${activeProject.defaultBranch}`}
                            >
                              {activeProject.defaultBranch}
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5">
                      leading
                    </span>
                  </li>
                  {projectRepos.map((repo) => (
                    <li key={repo.id} className="flex items-center justify-between gap-2 text-sm border border-gray-200 dark:border-gray-700 rounded px-2.5 py-1.5">
                      {/* #635: the path and branch shared one `truncate` span with no title.
                          Truncation cuts from the RIGHT, so with 17 repos under a common
                          prefix the column showed almost nothing but the prefix — and the
                          branch, the part that revealed comet's leading repo was on a
                          different base than all 16 siblings, was always the first thing cut.
                          The branch is its own non-truncating chip now, and the path carries
                          a title. */}
                      <div className="min-w-0">
                        <span className="font-medium">{repo.name ?? repo.path}</span>
                        <span className="flex items-baseline gap-1.5 text-xs">
                          <span
                            className="text-gray-500 font-mono truncate"
                            style={{ direction: "rtl", textAlign: "left" }}
                            title={repo.path}
                          >
                            {/* rtl direction ellipsises the LEFT (the shared prefix) and keeps
                                the distinguishing tail visible; the bidi isolate stops the
                                path itself being reordered. */}
                            <bdi>{repo.path}</bdi>
                          </span>
                          {repo.defaultBranch && (
                            <span
                              className="shrink-0 px-1 py-0 rounded font-mono text-[10px] bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                              title={`Base branch: ${repo.defaultBranch}`}
                            >
                              {repo.defaultBranch}
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="flex items-center gap-2.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => void handleMakeLeading(repo)}
                          disabled={promotingRepoId === repo.id || removingRepoId === repo.id}
                          className="text-xs text-brand-600 hover:text-brand-800 disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Make this the project's leading repo (demotes the current leading to a sibling)"
                        >
                          {promotingRepoId === repo.id ? "Promoting…" : "Make leading"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRemoveRepo(repo)}
                          disabled={removingRepoId === repo.id || promotingRepoId === repo.id}
                          className="text-xs text-red-600 hover:text-red-800 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {removingRepoId === repo.id ? "Removing…" : "Remove"}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              );
            })()}
            <h3 className="text-sm font-semibold text-ink dark:text-stone-100 mb-2 shrink-0">Add a repository</h3>
            <form onSubmit={handleAddRepoSubmit} className="space-y-4 shrink-0">
              <div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-1">
                  <label className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
                    <input type="radio" name="add-repo-mode" checked={addRepoMode === "path"} onChange={() => { setAddRepoMode("path"); setAddRepoError(null); }} className="h-3.5 w-3.5 text-brand-600 focus:ring-brand-500" />
                    Local path
                  </label>
                  <label className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
                    <input type="radio" name="add-repo-mode" checked={addRepoMode === "clone"} onChange={() => { setAddRepoMode("clone"); setAddRepoError(null); }} className="h-3.5 w-3.5 text-brand-600 focus:ring-brand-500" />
                    Clone from URL
                  </label>
                  <label className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
                    <input type="radio" name="add-repo-mode" checked={addRepoMode === "create"} onChange={() => { setAddRepoMode("create"); setAddRepoError(null); }} className="h-3.5 w-3.5 text-brand-600 focus:ring-brand-500" />
                    Create new
                  </label>
                </div>
                <input
                  autoFocus
                  type="text"
                  value={addRepoInput}
                  onChange={(e) => setAddRepoInput(e.target.value)}
                  placeholder={addRepoMode === "clone" ? "https://github.com/user/repo.git" : addRepoMode === "create" ? "new-repo-name" : "C:/path/to/other-repo"}
                  className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 font-mono focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500"
                />
                {addRepoMode === "create" && (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    A new folder + git repo is created inside the project folder (beside the leading repo).
                  </p>
                )}
              </div>
              {addRepoError && <p className="text-sm text-red-600">{addRepoError}</p>}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddRepo(false)}
                  className="px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={addingRepo || !addRepoInput.trim()}
                  className="px-3 py-1.5 text-sm text-white bg-brand-600 rounded-md hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {addingRepo ? "Adding…" : "Add repository"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
