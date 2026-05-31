import { useEffect, useMemo, useState } from "react";

export interface ProjectTabProject {
  id: string;
  name: string;
  color?: string | null;
}

export interface ProjectTabState {
  pinnedIds: string[];
  recentIds: string[];
}

export interface ProjectTabItem extends ProjectTabProject {
  pinned: boolean;
}

const STORAGE_KEY = "kanban-project-tabs-v1";
const MAX_VISIBLE_TABS = 5;
const MAX_RECENT_TABS = 8;

const EMPTY_STATE: ProjectTabState = { pinnedIds: [], recentIds: [] };

function uniqueKnownIds(ids: string[], knownIds: Set<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (!knownIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function sanitizeProjectTabState(state: ProjectTabState, projects: ProjectTabProject[]): ProjectTabState {
  const knownIds = new Set(projects.map((project) => project.id));
  return {
    pinnedIds: uniqueKnownIds(state.pinnedIds, knownIds),
    recentIds: uniqueKnownIds(state.recentIds, knownIds).slice(0, MAX_RECENT_TABS),
  };
}

export function updateProjectTabRecentState(state: ProjectTabState, projectId: string, projects: ProjectTabProject[]): ProjectTabState {
  const sanitized = sanitizeProjectTabState(state, projects);
  if (!projects.some((project) => project.id === projectId)) return sanitized;

  return {
    ...sanitized,
    recentIds: [projectId, ...sanitized.recentIds.filter((id) => id !== projectId)].slice(0, MAX_RECENT_TABS),
  };
}

export function togglePinnedProjectTab(state: ProjectTabState, projectId: string, projects: ProjectTabProject[]): ProjectTabState {
  const sanitized = sanitizeProjectTabState(state, projects);
  if (!projects.some((project) => project.id === projectId)) return sanitized;
  const isPinned = sanitized.pinnedIds.includes(projectId);

  return {
    ...sanitized,
    pinnedIds: isPinned
      ? sanitized.pinnedIds.filter((id) => id !== projectId)
      : [projectId, ...sanitized.pinnedIds],
  };
}

export function buildProjectTabs(state: ProjectTabState, projects: ProjectTabProject[], activeProjectId: string | null): ProjectTabItem[] {
  const sanitized = sanitizeProjectTabState(state, projects);
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const orderedIds = [
    ...sanitized.pinnedIds,
    ...sanitized.recentIds.filter((id) => !sanitized.pinnedIds.includes(id)),
  ];

  if (activeProjectId && projectById.has(activeProjectId) && !orderedIds.includes(activeProjectId)) {
    orderedIds.unshift(activeProjectId);
  }

  return orderedIds
    .map((id) => projectById.get(id))
    .filter((project): project is ProjectTabProject => Boolean(project))
    .map((project) => ({ ...project, pinned: sanitized.pinnedIds.includes(project.id) }));
}

function loadProjectTabState(): ProjectTabState {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<ProjectTabState> | null;
    if (!parsed || !Array.isArray(parsed.pinnedIds) || !Array.isArray(parsed.recentIds)) return EMPTY_STATE;
    return { pinnedIds: parsed.pinnedIds, recentIds: parsed.recentIds };
  } catch {
    return EMPTY_STATE;
  }
}

function saveProjectTabState(state: ProjectTabState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

interface ProjectTabsProps {
  projects: ProjectTabProject[];
  activeProjectId: string | null;
  onProjectChange?: (id: string) => void;
}

export function ProjectTabs({ projects, activeProjectId, onProjectChange }: ProjectTabsProps) {
  const [state, setState] = useState<ProjectTabState>(() => loadProjectTabState());

  useEffect(() => {
    setState((prev) => {
      const next = activeProjectId
        ? updateProjectTabRecentState(prev, activeProjectId, projects)
        : sanitizeProjectTabState(prev, projects);
      saveProjectTabState(next);
      return next;
    });
  }, [activeProjectId, projects]);

  const tabs = useMemo(() => buildProjectTabs(state, projects, activeProjectId), [state, projects, activeProjectId]);
  const visibleTabs = tabs.slice(0, MAX_VISIBLE_TABS);
  const overflowTabs = tabs.slice(MAX_VISIBLE_TABS);

  function handleTogglePinned(projectId: string) {
    setState((prev) => {
      const next = togglePinnedProjectTab(prev, projectId, projects);
      saveProjectTabState(next);
      return next;
    });
  }

  if (projects.length <= 1) return null;

  return (
    <div className="flex items-center gap-1 min-w-0 max-w-full" aria-label="Pinned project tabs">
      <div className="flex items-center gap-1 min-w-0 overflow-hidden">
        {visibleTabs.length === 0 ? (
          <span className="hidden sm:inline text-xs text-gray-400 dark:text-gray-500 px-2">No quick tabs</span>
        ) : (
          visibleTabs.map((project) => {
            const isActive = project.id === activeProjectId;
            return (
              <div
                key={project.id}
                className={`group flex items-center min-w-0 max-w-[9rem] rounded-md border text-xs ${
                  isActive
                    ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950/50 dark:text-brand-200"
                    : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onProjectChange?.(project.id)}
                  className="flex items-center gap-1 min-w-0 px-2 py-1"
                  aria-current={isActive ? "page" : undefined}
                  title={`Switch project: ${project.name}`}
                >
                  {project.color && (
                    <span
                      className="h-2 w-2 rounded-full border border-black/10 dark:border-white/20 shrink-0"
                      style={{ backgroundColor: project.color }}
                    />
                  )}
                  <span className="truncate">{project.name}</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleTogglePinned(project.id)}
                  className={`px-1.5 py-1 border-l border-inherit ${project.pinned ? "text-brand-600 dark:text-brand-300" : "text-gray-300 hover:text-gray-500 dark:text-gray-600 dark:hover:text-gray-300"}`}
                  title={project.pinned ? `Unpin ${project.name}` : `Pin ${project.name}`}
                  aria-label={project.pinned ? `Unpin ${project.name}` : `Pin ${project.name}`}
                >
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill={project.pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3.5l2.6 5.3 5.9.9-4.3 4.2 1 5.9L12 17l-5.2 2.8 1-5.9-4.3-4.2 5.9-.9L12 3.5z" />
                  </svg>
                </button>
              </div>
            );
          })
        )}
      </div>
      {overflowTabs.length > 0 && (
        <select
          value=""
          onChange={(event) => {
            if (event.target.value) onProjectChange?.(event.target.value);
            event.currentTarget.value = "";
          }}
          className="text-xs border border-gray-200 dark:border-gray-700 rounded-md px-1.5 py-1 bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-300 focus:outline-none focus:ring-1 focus:ring-brand-500"
          aria-label="More pinned project tabs"
          title={`${overflowTabs.length} more quick tabs`}
        >
          <option value="">+{overflowTabs.length}</option>
          {overflowTabs.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
