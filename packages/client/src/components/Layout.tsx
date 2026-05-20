import { type ReactNode, useRef, useState } from "react";

interface Project {
  id: string;
  name: string;
}

interface RegisterOptions {
  repoPath: string;
  gitignoreTemplate: string;
  generateReadme: boolean;
}

interface LayoutProps {
  children: ReactNode;
  projects?: Project[];
  activeProjectId?: string | null;
  onProjectChange?: (id: string) => void;
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
  onRegisterProject?: (repoPath: string) => Promise<void>;
  onCreateProject?: (name: string, path: string) => Promise<void>;
=======
  onRegisterProject?: (opts: RegisterOptions) => Promise<void>;
>>>>>>> f36a871 (feat: add optional README and .gitignore template to project creation dialog)
=======
  onRegisterProject?: (args: { repoPath: string; gitignoreTemplate: string; generateReadme: boolean }) => Promise<void>;
=======
  onRegisterProject?: (opts: { repoPath: string; gitignoreTemplate: string; generateReadme: boolean }) => Promise<void>;
>>>>>>> 76091bc (fix: correct LayoutProps onRegisterProject type signature)
=======
  onRegisterProject?: (options: { repoPath: string; gitignoreTemplate: string; generateReadme: boolean }) => Promise<void>;
>>>>>>> 3ce95e1 (feat: add All Workspaces aggregate panel (#101))
  onCreateProject?: (name: string, path: string, gitignoreTemplate: string, generateReadme: boolean) => Promise<void>;
>>>>>>> 7dd2d0e (fix: correct onRegisterProject prop type to accept object in Layout.tsx)
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  priorityFilter?: string;
  onPriorityFilterChange?: (priority: string) => void;
  onAllWorkspacesClick?: () => void;
  onWorktreeOverviewClick?: () => void;
  onSettingsClick?: () => void;
}

export function Layout({
  children,
  projects = [],
  activeProjectId,
  onProjectChange,
  onRegisterProject,
  onCreateProject,
  searchQuery = "",
  onSearchChange,
  priorityFilter = "",
  onPriorityFilterChange,
  onAllWorkspacesClick,
  onWorktreeOverviewClick,
  onSettingsClick,
}: LayoutProps) {
  const [showRegister, setShowRegister] = useState(false);
  const [modalTab, setModalTab] = useState<"import" | "create">("import");
  const [repoPath, setRepoPath] = useState("");
  const [gitignoreTemplate, setGitignoreTemplate] = useState("");
  const [generateReadme, setGenerateReadme] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [createName, setCreateName] = useState("");
  const [createPath, setCreatePath] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createNameInvalid = /[/\\<>:"|?*\x00]/.test(createName);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleRegisterSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!repoPath.trim()) return;
    setRegistering(true);
    setRegisterError(null);
    try {
      await onRegisterProject?.({ repoPath: repoPath.trim(), gitignoreTemplate, generateReadme });
      setShowRegister(false);
      setRepoPath("");
      setGitignoreTemplate("");
      setGenerateReadme(false);
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegistering(false);
    }
  }

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!createName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await onCreateProject?.(createName.trim(), createPath.trim());
      setShowRegister(false);
      setCreateName("");
      setCreatePath("");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  function openRegister() {
    setRegisterError(null);
    setCreateError(null);
    setRepoPath("");
<<<<<<< HEAD
    setCreateName("");
    setCreatePath("");
    setModalTab("import");
=======
    setGitignoreTemplate("");
    setGenerateReadme(false);
>>>>>>> f36a871 (feat: add optional README and .gitignore template to project creation dialog)
    setShowRegister(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-4 py-2 shrink-0">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
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
            <button
              onClick={openRegister}
              className="p-1 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100"
              title="Register project"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
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
                placeholder='Search issues... ("/")'
                className="pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-md w-32 sm:w-48 md:w-64 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
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
            <button
              onClick={onAllWorkspacesClick}
              className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100"
              title="All Workspaces"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            </button>
            <button
              onClick={onAllWorkspacesClick}
              className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100"
              title="All Workspaces"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            </button>
            <button
              onClick={onWorktreeOverviewClick}
              className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100"
              title="Worktrees"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
            </button>
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
      <main className="flex-1 min-h-0 overflow-hidden">{children}</main>

      {showRegister && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
          onClick={(e) => { if (e.target === e.currentTarget) setShowRegister(false); }}
        >
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4 p-6">
<<<<<<< HEAD
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Add Project</h2>
            <div className="flex border-b border-gray-200 mb-4">
              <button
                type="button"
                onClick={() => setModalTab("import")}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${modalTab === "import" ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"}`}
              >
                Import existing
              </button>
              <button
                type="button"
                onClick={() => setModalTab("create")}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${modalTab === "create" ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"}`}
              >
                Create new
              </button>
            </div>

            {modalTab === "import" && (
              <form onSubmit={handleRegisterSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Repository path
                  </label>
                  <input
                    ref={inputRef}
                    type="text"
                    value={repoPath}
                    onChange={(e) => setRepoPath(e.target.value)}
                    placeholder="C:/path/to/repo"
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Absolute path to a git repository. Branch and remote URL are auto-detected.
                  </p>
                </div>
                {registerError && (
                  <p className="text-sm text-red-600">{registerError}</p>
                )}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowRegister(false)}
                    className="px-3 py-1.5 text-sm text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={registering || !repoPath.trim()}
                    className="px-3 py-1.5 text-sm text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {registering ? "Registering…" : "Register"}
                  </button>
                </div>
              </form>
            )}

            {modalTab === "create" && (
              <form onSubmit={handleCreateSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Project name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    placeholder="my-project"
                    className={`w-full text-sm border rounded-md px-3 py-2 focus:outline-none focus:ring-1 ${createNameInvalid ? "border-red-400 focus:ring-red-400 focus:border-red-400" : "border-gray-300 focus:ring-blue-500 focus:border-blue-500"}`}
                    autoFocus
                  />
                  {createNameInvalid && (
                    <p className="mt-1 text-xs text-red-600">Name cannot contain: / \ &lt; &gt; : " | ? *</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Path <span className="text-gray-400 font-normal">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={createPath}
                    onChange={(e) => setCreatePath(e.target.value)}
                    placeholder="Defaults to projects base directory / name"
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Leave blank to use the base directory from Settings › Project. A new folder and git repo will be created.
                  </p>
                </div>
                {createError && (
                  <p className="text-sm text-red-600">{createError}</p>
                )}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowRegister(false)}
                    className="px-3 py-1.5 text-sm text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={creating || !createName.trim() || createNameInvalid}
                    className="px-3 py-1.5 text-sm text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {creating ? "Creating…" : "Create project"}
                  </button>
                </div>
              </form>
            )}
=======
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Register Project</h2>
            <form onSubmit={handleRegisterSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Repository path
                </label>
                <input
                  ref={inputRef}
                  type="text"
                  value={repoPath}
                  onChange={(e) => setRepoPath(e.target.value)}
                  placeholder="C:/path/to/repo"
                  className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Absolute path to a git repository. Branch and remote URL are auto-detected.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  .gitignore template
                </label>
                <select
                  value={gitignoreTemplate}
                  onChange={(e) => setGitignoreTemplate(e.target.value)}
                  className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="">None</option>
                  <option value="node">Node</option>
                  <option value="python">Python</option>
                  <option value="java">Java</option>
                  <option value="go">Go</option>
                  <option value="rust">Rust</option>
                  <option value="ruby">Ruby</option>
                  <option value="dotnet">.NET / C#</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={generateReadme}
                  onChange={(e) => setGenerateReadme(e.target.checked)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                Generate README.md
              </label>
              {registerError && (
                <p className="text-sm text-red-600">{registerError}</p>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowRegister(false)}
                  className="px-3 py-1.5 text-sm text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={registering || !repoPath.trim()}
                  className="px-3 py-1.5 text-sm text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {registering ? "Registering…" : "Register"}
                </button>
              </div>
            </form>
>>>>>>> f36a871 (feat: add optional README and .gitignore template to project creation dialog)
          </div>
        </div>
      )}
    </div>
  );
}
