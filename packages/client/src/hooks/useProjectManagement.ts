import type { StatusWithIssues } from "@agentic-kanban/shared";
import { apiPost, apiPut, apiDelete } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { boardSelectionActions } from "../stores/boardSelectionStore.js";

type ProjectRef = { id: string; name: string };

interface UseProjectManagementDeps {
  activeProjectId: string | null;
  projects: ProjectRef[];
  archivedProjects: ProjectRef[];
  setActiveProjectId: (id: string | null) => void;
  setColumns: React.Dispatch<React.SetStateAction<StatusWithIssues[]>>;
  columnsRef: React.RefObject<StatusWithIssues[]>;
  setSwitchingProject: (v: boolean) => void;
  refetchBoard: (projectId?: string, options?: { force?: boolean }) => Promise<StatusWithIssues[] | undefined>;
  loadProjects: () => Promise<string | undefined> | Promise<void>;
}

/**
 * BoardPage's project-lifecycle handlers: switch active project, register /
 * create / unregister / archive / unarchive. Extracted from BoardPage; the page
 * destructures these with the same names and passes them to <Layout> unchanged.
 */
export function useProjectManagement(deps: UseProjectManagementDeps) {
  const {
    activeProjectId,
    projects,
    archivedProjects,
    setActiveProjectId,
    setColumns,
    columnsRef,
    setSwitchingProject,
    refetchBoard,
    loadProjects,
  } = deps;
  const { setSelectedIssue, setWorkspaceIssue } = boardSelectionActions;

  async function handleProjectChange(id: string) {
    setActiveProjectId(id);
    setColumns([]);
    columnsRef.current = [];
    setSelectedIssue(null);
    setWorkspaceIssue(null);
    setSwitchingProject(true);
    try {
      await apiPut("/api/preferences/active-project", { projectId: id });
      await refetchBoard(id, { force: true });
    } catch {
      showToast("Failed to switch project", "error");
    } finally {
      setSwitchingProject(false);
    }
  }

  async function handleRegisterProject({ repoPath, cloneUrl, gitignoreTemplate, generateReadme, additionalRepos }: { repoPath?: string; cloneUrl?: string; gitignoreTemplate: string; generateReadme: boolean; additionalRepos?: string[] }) {
    const result = await apiPost<{ id: string; name: string; error?: string }>("/api/projects", { repoPath, cloneUrl, gitignoreTemplate: gitignoreTemplate || undefined, generateReadme: generateReadme || undefined });
    if (result.error) throw new Error(result.error);
    // Multi-repo setup: the registered repo is the leading repo; attach the rest as siblings.
    // Each is a separate POST so one bad path is reported without discarding the good ones.
    const siblings = (additionalRepos ?? []).map((s) => s.trim()).filter(Boolean);
    const failed: string[] = [];
    for (const entry of siblings) {
      const body = /^(https?:|git@|ssh:\/\/)/i.test(entry) ? { cloneUrl: entry } : { path: entry };
      try {
        const r = await apiPost<{ error?: string }>(`/api/projects/${result.id}/repos`, body);
        if (r.error) failed.push(`${entry}: ${r.error}`);
      } catch (err) {
        failed.push(`${entry}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await loadProjects();
    await handleProjectChange(result.id);
    if (failed.length > 0) {
      showToast(`Registered "${result.name}", but ${failed.length} repo(s) failed: ${failed.join("; ")}`, "error");
    } else if (siblings.length > 0) {
      showToast(`Registered "${result.name}" with ${siblings.length + 1} repos`, "success");
    } else {
      showToast(`Registered "${result.name}"`, "success");
    }
  }

  async function handleCreateProject(name: string, path: string, gitignoreTemplate: string, generateReadme: boolean) {
    const body: Record<string, unknown> = { name };
    if (path) body.path = path;
    if (gitignoreTemplate) body.gitignoreTemplate = gitignoreTemplate;
    if (generateReadme) body.generateReadme = generateReadme;
    const result = await apiPost<{ id: string; name: string; error?: string }>("/api/projects/create", body);
    if (result.error) throw new Error(result.error);
    await loadProjects();
    await handleProjectChange(result.id);
    showToast(`Created "${result.name}"`, "success");
  }

  async function handleUnregisterProject(id: string) {
    const project = projects.find((p) => p.id === id);
    await apiDelete(`/api/projects/${id}`);
    const remaining = projects.filter((p) => p.id !== id);
    if (remaining.length > 0) {
      await handleProjectChange(remaining[0].id);
    } else {
      setActiveProjectId(null);
    }
    await loadProjects();
    showToast(`Removed "${project?.name ?? "project"}"`, "success");
  }

  async function handleArchiveProject(id: string) {
    const project = projects.find((p) => p.id === id);
    await apiPost(`/api/projects/${id}/archive`);
    if (activeProjectId === id) {
      const remaining = projects.filter((p) => p.id !== id);
      if (remaining.length > 0) {
        await handleProjectChange(remaining[0].id);
      } else {
        setActiveProjectId(null);
      }
    }
    await loadProjects();
    showToast(`Archived "${project?.name ?? "project"}"`, "success");
  }

  async function handleUnarchiveProject(id: string) {
    const project = archivedProjects.find((p) => p.id === id);
    await apiPost(`/api/projects/${id}/unarchive`);
    await loadProjects();
    await handleProjectChange(id);
    showToast(`Restored "${project?.name ?? "project"}"`, "success");
  }

  return {
    handleProjectChange,
    handleRegisterProject,
    handleCreateProject,
    handleUnregisterProject,
    handleArchiveProject,
    handleUnarchiveProject,
  };
}
