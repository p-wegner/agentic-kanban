import type { ReactNode } from "react";

interface Project {
  id: string;
  name: string;
}

interface LayoutProps {
  children: ReactNode;
  projects?: Project[];
  activeProjectId?: string | null;
  onProjectChange?: (id: string) => void;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  priorityFilter?: string;
  onPriorityFilterChange?: (priority: string) => void;
  onSettingsClick?: () => void;
}

export function Layout({
  children,
  projects = [],
  activeProjectId,
  onProjectChange,
  searchQuery = "",
  onSearchChange,
  priorityFilter = "",
  onPriorityFilterChange,
  onSettingsClick,
}: LayoutProps) {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-gray-900 shrink-0">
              Agentic Kanban
            </h1>
            {projects.length > 1 && (
              <select
                value={activeProjectId ?? ""}
                onChange={(e) => onProjectChange?.(e.target.value)}
                className="text-sm border border-gray-300 rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            {projects.length === 1 && (
              <span className="text-sm text-gray-500">{projects[0].name}</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <svg
                className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                id="search-input"
                type="text"
                value={searchQuery}
                onChange={(e) => onSearchChange?.(e.target.value)}
                placeholder='Search issues... (press "/")'
                className="pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-md w-64 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
              />
              {searchQuery && (
                <button
                  onClick={() => onSearchChange?.("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs"
                >
                  &times;
                </button>
              )}
            </div>
            <select
              value={priorityFilter}
              onChange={(e) => onPriorityFilterChange?.(e.target.value)}
              className="text-sm border border-gray-300 rounded-md px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">All priorities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
            <button
              onClick={onSettingsClick}
              className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100"
              title="Settings"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          </div>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
