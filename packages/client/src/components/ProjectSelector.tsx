import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon.js";

export interface ProjectSelectorProject {
  id: string;
  name: string;
  color?: string | null;
  repoName?: string | null;
  repoPath?: string | null;
  defaultBranch?: string | null;
  /** Number of workspaces in this project whose agent is currently active. */
  activeWorkspaceCount?: number;
}

interface ActiveAgentsBadgeProps {
  count: number;
  /** Compact form (no label text) for the small trigger button. */
  compact?: boolean;
}

/**
 * A small pulsing-dot pill showing how many agents are actively working in a
 * project. Renders nothing when there are no active agents.
 */
export function ActiveAgentsBadge({ count, compact = false }: ActiveAgentsBadgeProps) {
  if (count <= 0) return null;
  const label = compact ? String(count) : `${count} active agent${count === 1 ? "" : "s"}`;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium leading-none text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
      title={`${count} active agent${count === 1 ? "" : "s"}`}
    >
      <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
      </span>
      {label}
    </span>
  );
}

/**
 * #411 — the switcher rendered gate-parked, converged and idle projects identically, so
 * an operator scanning 19 projects could not see which ones were waiting on them. This
 * dot is that scan: amber, per row, from the same `/api/inbox` sweep the bell uses.
 */
/**
 * `scope` names WHOSE decisions the count covers (#653).
 *
 * The trigger badge deliberately counts the OTHER projects (see its call site), but the label
 * never said so — and it sits inside a button whose visible content is `comet · 21 projects`,
 * so the button's accessible name came out as "comet 21 projects 3 3 decisions waiting on
 * you". A screen reader, and anyone hovering, was told comet had 3 pending decisions when all
 * 3 belonged to other projects. The neighbouring surfaces already get this right: the
 * notification dropdown is headed "WAITING ON YOU — ALL PROJECTS" and names each project.
 */
export function WaitingBadge({
  count,
  compact = false,
  scope = "this project",
}: { count: number; compact?: boolean; scope?: "this project" | "other projects" }) {
  if (count <= 0) return null;
  const title = scope === "other projects"
    ? `${count} decision${count === 1 ? "" : "s"} waiting on you in OTHER projects`
    : `${count} decision${count === 1 ? "" : "s"} waiting on you`;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium leading-none text-amber-700 dark:bg-amber-950/50 dark:text-amber-300"
      title={title}
      data-testid="project-waiting-badge"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
      {compact ? count : `✋ ${count}`}
      <span className="sr-only">{title}</span>
    </span>
  );
}

export function getProjectInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

export function filterProjects(projects: ProjectSelectorProject[], query: string): ProjectSelectorProject[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return projects;

  return projects.filter((project) => {
    const haystack = [
      project.name,
      project.repoName,
      project.repoPath,
      project.defaultBranch,
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(normalized);
  });
}

interface ProjectSelectorProps {
  projects: ProjectSelectorProject[];
  activeProjectId: string | null;
  onProjectChange?: (id: string) => void;
  /** projectId → number of inbox items blocked on a human (#411). */
  waitingCounts?: Map<string, number>;
}

export function ProjectSelector({ projects, activeProjectId, onProjectChange, waitingCounts }: ProjectSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? projects[0] ?? null;
  const filteredProjects = useMemo(() => filterProjects(projects, query), [projects, query]);
  const otherProjectsWaiting = useMemo(() => {
    if (!waitingCounts) return 0;
    let total = 0;
    for (const [id, count] of waitingCounts) if (id !== activeProject?.id) total += count;
    return total;
  }, [waitingCounts, activeProject?.id]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    const t = setTimeout(() => searchRef.current?.focus(), 0);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      clearTimeout(t);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  if (!activeProject) return null;

  return (
    <div className="relative min-w-0 max-w-[8rem] sm:max-w-[16rem]" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        /* `w-full` (the width caps now live on the wrapper) keeps the trigger inside its
           min-w-0, shrinkable parent. Sized to its CONTENT it overflowed to the right whenever
           the header ran out of room — measured overlapping the #411 waiting chip by 14px. */
        className="flex h-8 w-full items-center gap-2 rounded-md border border-gray-200 bg-white px-2.5 text-left text-sm text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
        title="Switch project"
      >
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-black/10 text-[10px] font-semibold text-gray-700 dark:border-white/20 dark:text-gray-100"
          style={{ backgroundColor: activeProject.color ?? undefined }}
          aria-hidden="true"
        >
          {!activeProject.color && getProjectInitials(activeProject.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium leading-4">{activeProject.name}</span>
          {projects.length > 1 && (
            <span className="hidden sm:block truncate text-[10px] leading-3 text-gray-400 dark:text-gray-500">
              {projects.length} projects
            </span>
          )}
        </span>
        <ActiveAgentsBadge count={activeProject.activeWorkspaceCount ?? 0} compact />
        {/* The ACTIVE project's own wait is already spelled out by the header chip beside
            this button, so the trigger counts the OTHER projects — that is the number an
            operator cannot otherwise get without opening the list. */}
        <WaitingBadge count={otherProjectsWaiting} compact scope="other projects" />
        <Icon className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" d="m6 9 6 6 6-6" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Project selection"
          className="absolute left-0 top-full z-50 mt-2 w-[min(22rem,calc(100vw-1.5rem))] rounded-md border border-gray-200 bg-white p-2 shadow-xl dark:border-gray-700 dark:bg-gray-900"
        >
          <div className="relative mb-2">
            <Icon className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </Icon>
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find project"
              className="h-8 w-full rounded-md border border-gray-200 bg-white pl-8 pr-3 text-sm text-gray-700 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
            />
          </div>

          <div className="max-h-80 overflow-y-auto pr-1">
            {filteredProjects.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-gray-500 dark:text-gray-400">No matching projects</div>
            ) : (
              <div className="space-y-1">
                {filteredProjects.map((project) => {
                  const active = project.id === activeProjectId;
                  return (
                    <button
                      key={project.id}
                      type="button"
                      onClick={() => {
                        if (!active) onProjectChange?.(project.id);
                        setOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left transition ${
                        active
                          ? "border-brand-300 bg-brand-50 text-brand-800 dark:border-brand-800 dark:bg-brand-950/50 dark:text-brand-100"
                          : "border-transparent text-gray-700 hover:border-gray-200 hover:bg-gray-50 dark:text-gray-200 dark:hover:border-gray-700 dark:hover:bg-gray-800"
                      }`}
                      aria-current={active ? "page" : undefined}
                    >
                      <span
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-black/10 text-xs font-semibold text-gray-700 dark:border-white/20 dark:text-gray-100"
                        style={{ backgroundColor: project.color ?? undefined }}
                        aria-hidden="true"
                      >
                        {!project.color && getProjectInitials(project.name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{project.name}</span>
                        <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                          {project.repoName || project.repoPath || "No repository path"}
                          {project.defaultBranch ? ` - ${project.defaultBranch}` : ""}
                        </span>
                      </span>
                      <ActiveAgentsBadge count={project.activeWorkspaceCount ?? 0} />
                      <WaitingBadge count={waitingCounts?.get(project.id) ?? 0} />
                      {active && (
                        <Icon className="h-4 w-4 shrink-0 text-brand-600 dark:text-brand-300" strokeWidth="2.5" d="M5 13l4 4L19 7" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
