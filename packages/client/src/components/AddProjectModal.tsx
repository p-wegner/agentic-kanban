import { useEffect, useRef, useState } from "react";
import { useRegistrationProgress } from "../hooks/useRegistrationProgress.js";
import type { ProjectListItem as Project } from "../lib/projectTypes.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * The "Add Project" modal (register-existing / create-new tabs, plus the archived-projects
 * restore list at the bottom). Split out of Layout.tsx (#465) — this block was a self-contained
 * ~270-line unit with its own form state, so it moves as one component rather than a shuffle.
 * #464 reworks this modal's flow next; extracting it here means both tickets touch a small
 * file instead of colliding in Layout.tsx.
 */
export function AddProjectModal({
  open,
  onClose,
  onRegisterProject,
  onCreateProject,
  archivedProjects,
  onUnarchiveProject,
}: {
  open: boolean;
  onClose: () => void;
  onRegisterProject?: (args: { repoPath?: string; cloneUrl?: string; gitignoreTemplate: string; generateReadme: boolean; additionalRepos?: string[]; progressId?: string }) => Promise<void>;
  onCreateProject?: (name: string, path: string, gitignoreTemplate: string, generateReadme: boolean) => Promise<void>;
  archivedProjects: Project[];
  onUnarchiveProject?: (id: string) => Promise<void>;
}) {
  const [modalTab, setModalTab] = useState<"import" | "create">("import");
  const [importMode, setImportMode] = useState<"path" | "clone">("path");
  const [repoPath, setRepoPath] = useState("");
  const [gitignoreTemplate, setGitignoreTemplate] = useState("");
  const [generateReadme, setGenerateReadme] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  // #388 — which phase is running, so a slow step is visibly slow rather than a bare spinner.
  const { progress, elapsedMs, begin: beginProgress, end: endProgress } = useRegistrationProgress();
  // Multi-repo setup: additional sibling repo paths entered alongside the leading repo.
  const [additionalRepos, setAdditionalRepos] = useState<string[]>([]);
  const [createName, setCreateName] = useState("");
  const [createPath, setCreatePath] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createNameInvalid = /[/\\<>:"|?*\x00]/.test(createName);
  const [unarchivingId, setUnarchivingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset the form and focus the primary field every time the modal opens — mirrors the
  // reset that used to live in Layout's openRegister before this state moved here.
  useEffect(() => {
    if (!open) return;
    setRegisterError(null);
    setCreateError(null);
    setRepoPath("");
    setCreateName("");
    setCreatePath("");
    setGitignoreTemplate("");
    setGenerateReadme(false);
    setAdditionalRepos([]);
    setModalTab("import");
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

  if (!open) return null;

  async function handleRegisterSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!repoPath.trim()) return;
    setRegistering(true);
    setRegisterError(null);
    const progressId = beginProgress();
    try {
      await onRegisterProject?.({
        ...(importMode === "clone" ? { cloneUrl: repoPath.trim() } : { repoPath: repoPath.trim() }),
        gitignoreTemplate,
        generateReadme,
        additionalRepos: additionalRepos.map((r) => r.trim()).filter(Boolean),
        progressId,
      });
      onClose();
      setRepoPath("");
      setGitignoreTemplate("");
      setGenerateReadme(false);
      setAdditionalRepos([]);
    } catch (err) {
      setRegisterError(errorMessage(err));
    } finally {
      setRegistering(false);
      endProgress();
    }
  }

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!createName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await onCreateProject?.(createName.trim(), createPath.trim(), gitignoreTemplate, generateReadme);
      onClose();
      setCreateName("");
      setCreatePath("");
      setGitignoreTemplate("");
      setGenerateReadme(false);
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleUnarchive(id: string) {
    if (!onUnarchiveProject) return;
    setUnarchivingId(id);
    try {
      await onUnarchiveProject(id);
    } finally {
      setUnarchivingId(null);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-surface-raised dark:bg-surface-raised-dark rounded-lg shadow-xl w-full max-w-md mx-4 p-6">
        <h2 className="text-lg font-semibold text-ink dark:text-stone-100 mb-4">Add Project</h2>
        <div className="flex border-b border-gray-200 dark:border-gray-700 mb-4">
          <button
            type="button"
            onClick={() => setModalTab("import")}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${modalTab === "import" ? "border-brand-600 text-brand-600" : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"}`}
          >
            Import existing
          </button>
          <button
            type="button"
            onClick={() => setModalTab("create")}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${modalTab === "create" ? "border-brand-600 text-brand-600" : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"}`}
          >
            Create new
          </button>
        </div>

        {modalTab === "import" && (
          <form onSubmit={handleRegisterSubmit} className="space-y-4">
            <div>
              <div className="flex items-center gap-4 mb-1">
                <label className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
                  <input
                    type="radio"
                    name="import-mode"
                    checked={importMode === "path"}
                    onChange={() => setImportMode("path")}
                    className="h-3.5 w-3.5 text-brand-600 focus:ring-brand-500"
                  />
                  Local path
                </label>
                <label className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
                  <input
                    type="radio"
                    name="import-mode"
                    checked={importMode === "clone"}
                    onChange={() => setImportMode("clone")}
                    className="h-3.5 w-3.5 text-brand-600 focus:ring-brand-500"
                  />
                  Clone from URL
                </label>
              </div>
              <input
                ref={inputRef}
                type="text"
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                placeholder={importMode === "clone" ? "https://github.com/user/repo.git" : "C:/path/to/repo"}
                className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {additionalRepos.length > 0
                  ? "The leading repository — the agent starts here. The repos below are worked on alongside it."
                  : importMode === "clone"
                  ? "Git URL to clone into the server's repos directory. Branch and remote URL are auto-detected."
                  : "Absolute path to a git repository. Branch and remote URL are auto-detected."}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Additional repositories <span className="text-gray-400 dark:text-gray-500 font-normal">(optional — makes this a multi-repo project)</span>
              </label>
              {additionalRepos.map((val, i) => (
                <div key={i} className="flex gap-2 mb-1.5">
                  <input
                    type="text"
                    value={val}
                    onChange={(e) => setAdditionalRepos((rs) => rs.map((r, j) => (j === i ? e.target.value : r)))}
                    placeholder="C:/path/to/other-repo  or  https://github.com/user/repo.git"
                    className="flex-1 text-sm border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 font-mono focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500"
                  />
                  <button
                    type="button"
                    onClick={() => setAdditionalRepos((rs) => rs.filter((_, j) => j !== i))}
                    className="shrink-0 px-2 text-sm text-red-600 hover:text-red-800 border border-gray-300 dark:border-gray-600 rounded-md"
                    title="Remove this repository"
                  >
                    &times;
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setAdditionalRepos((rs) => [...rs, ""])}
                className="text-xs text-brand-600 hover:text-brand-800 dark:text-brand-400"
              >
                + Add another repository
              </button>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Each sibling repo gets a worktree on the same branch per workspace; merge lands every repo with commits. Local absolute paths or clone URLs.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Language <span className="text-gray-400 dark:text-gray-500 font-normal">(optional)</span>
              </label>
              <select
                value={gitignoreTemplate}
                onChange={(e) => setGitignoreTemplate(e.target.value)}
                className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500 bg-white dark:bg-gray-800"
              >
                <option value="">None</option>
                <option value="node">Node.js</option>
                <option value="python">Python</option>
                <option value="java">Java</option>
                <option value="go">Go</option>
                <option value="rust">Rust</option>
                <option value="ruby">Ruby</option>
                <option value="dotnet">.NET</option>
              </select>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Adds language-specific entries to .gitignore.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                id="import-generate-readme"
                type="checkbox"
                checked={generateReadme}
                onChange={(e) => setGenerateReadme(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
              />
              <label htmlFor="import-generate-readme" className="text-sm text-gray-700 dark:text-gray-300">
                Generate README.md <span className="text-gray-400 dark:text-gray-500">(skipped if file already exists)</span>
              </label>
            </div>
            {registerError && (
              <p className="text-sm text-red-600">{registerError}</p>
            )}
            {/*
              #388 — a 30-40s spinner with nothing to read left the user unable to tell cloning
              from stack detection from a hang. A phase list with checkmarks and an elapsed clock
              is enough: a slow phase is then VISIBLY slow rather than indistinguishable from
              wedged. No duration target is claimed anywhere — timing on this box is unusable and
              any before/after comparison would be noise (#368).
            */}
            {registering && (
              <div
                className="rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 p-2 text-xs"
                data-testid="registration-progress"
              >
                <div className="flex items-center justify-between text-gray-600 dark:text-gray-300">
                  <span>Registering…</span>
                  <span className="tabular-nums">{Math.floor(elapsedMs / 1000)}s</span>
                </div>
                {(progress?.phases ?? []).length === 0 ? (
                  <p className="mt-1 text-gray-500 dark:text-gray-400">Starting…</p>
                ) : (
                  <ul className="mt-1 space-y-0.5">
                    {progress!.phases.map((phase) => (
                      <li key={phase.phase} className="flex items-start gap-1.5">
                        <span className="w-3 shrink-0 text-center">
                          {phase.status === "done" ? "✓"
                            : phase.status === "skipped" ? "–"
                              : phase.status === "failed" ? "✕" : "…"}
                        </span>
                        <span className={phase.status === "running"
                          ? "text-gray-900 dark:text-gray-100"
                          : "text-gray-500 dark:text-gray-400"}>
                          {phase.label}
                          {phase.note && <span className="italic"> — {phase.note}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={registering || !repoPath.trim()}
                className="px-3 py-1.5 text-sm text-white bg-brand-600 rounded-md hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {registering ? "Registering…" : "Register"}
              </button>
            </div>
          </form>
        )}

        {modalTab === "create" && (
          <form onSubmit={handleCreateSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Project name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="my-project"
                className={`w-full text-sm border rounded-md px-3 py-2 focus:outline-none focus:ring-1 ${createNameInvalid ? "border-red-400 focus:ring-red-400 focus:border-red-400" : "border-gray-300 dark:border-gray-600 focus:ring-brand-500 focus:border-brand-500"}`}
                autoFocus
              />
              {createNameInvalid && (
                <p className="mt-1 text-xs text-red-600">Name cannot contain: / \ &lt; &gt; : " | ? *</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Path <span className="text-gray-400 dark:text-gray-500 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={createPath}
                onChange={(e) => setCreatePath(e.target.value)}
                placeholder="Defaults to projects base directory / name"
                className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Leave blank to use the base directory from Settings › Project. A new folder and git repo will be created.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Language <span className="text-gray-400 dark:text-gray-500 font-normal">(optional)</span>
              </label>
              <select
                value={gitignoreTemplate}
                onChange={(e) => setGitignoreTemplate(e.target.value)}
                className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500 bg-white dark:bg-gray-800"
              >
                <option value="">None</option>
                <option value="node">Node.js</option>
                <option value="python">Python</option>
                <option value="java">Java</option>
                <option value="go">Go</option>
                <option value="rust">Rust</option>
                <option value="ruby">Ruby</option>
                <option value="dotnet">.NET</option>
              </select>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Adds language-specific entries to .gitignore.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                id="create-generate-readme"
                type="checkbox"
                checked={generateReadme}
                onChange={(e) => setGenerateReadme(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
              />
              <label htmlFor="create-generate-readme" className="text-sm text-gray-700 dark:text-gray-300">
                Generate README.md <span className="text-gray-400 dark:text-gray-500">(skipped if file already exists)</span>
              </label>
            </div>
            {createError && (
              <p className="text-sm text-red-600">{createError}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creating || !createName.trim() || createNameInvalid}
                className="px-3 py-1.5 text-sm text-white bg-brand-600 rounded-md hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creating ? "Creating…" : "Create project"}
              </button>
            </div>
          </form>
        )}

        {onUnarchiveProject && archivedProjects.length > 0 && (
          <div className="mt-5 pt-4 border-t border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Archived projects</h3>
            <ul className="space-y-1 max-h-48 overflow-y-auto">
              {archivedProjects.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800">
                  <span className="flex items-center gap-2 min-w-0">
                    {p.color && (
                      <span className="h-2.5 w-2.5 rounded-full border border-black/10 dark:border-white/20 shrink-0" style={{ backgroundColor: p.color }} />
                    )}
                    <span className="truncate text-sm text-gray-700 dark:text-gray-200">{p.name}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => handleUnarchive(p.id)}
                    disabled={unarchivingId === p.id}
                    className="shrink-0 px-2 py-1 text-xs font-medium text-brand-700 dark:text-brand-300 border border-brand-300 dark:border-brand-700 rounded-md hover:bg-brand-50 dark:hover:bg-brand-950/50 disabled:opacity-50"
                  >
                    {unarchivingId === p.id ? "Restoring…" : "Restore"}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
