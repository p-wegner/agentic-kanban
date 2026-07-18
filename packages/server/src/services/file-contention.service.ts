import type { Database } from "../db/index.js";
import { NotFoundError } from "../errors/index.js";
import { getChangedFileNames } from "./git.service.js";
import { getProjectDefaultBranch, getActiveContentionWorkspaces } from "../repositories/file-contention.repository.js";
import { listWorkspaceRepos } from "../repositories/repo.repository.js";

export interface ContentionWorkspace {
  workspaceId: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  branch: string;
  status: string;
  issueStatus: string;
}

export interface ContentionFile {
  path: string;
  workspaces: ContentionWorkspace[];
}

export interface FileContentionResult {
  projectId: string;
  defaultBranch: string | null;
  contested: ContentionFile[];
  checkedAt: string;
}

const ACTIVE_STATUSES = ["active", "reviewing", "fixing"] as const;

export async function getFileContention(
  projectId: string,
  database: Database,
): Promise<FileContentionResult> {
  const project = await getProjectDefaultBranch(projectId, database);

  if (!project) {
    throw new NotFoundError(`Project not found: ${projectId}`);
  }
  const defaultBranch = project.defaultBranch;

  // Load active workspaces for this project with issue info
  const rows = await getActiveContentionWorkspaces(projectId, [...ACTIVE_STATUSES], database);

  // For each workspace, collect the set of touched files via git diff
  const fileToWorkspaces = new Map<string, ContentionWorkspace[]>();

  await Promise.all(rows.map(async (row) => {
    if (!row.workingDir) return;

    const baseBranch = row.baseBranch || defaultBranch;
    const diffRef = row.isDirect ? "HEAD" : baseBranch;
    if (!diffRef) return;

    let files: string[];
    try {
      files = await getChangedFileNames(row.workingDir, diffRef);
    } catch {
      return;
    }

    // Multi-repo (#77): also count each SIBLING repo's changed files, namespaced `name::file`
    // so overlap only matches within the SAME repo — mirrors merge-queue's #72 scan. Without
    // this, two workspaces that both edit the same file in a sibling repo look non-contending
    // (their leading worktrees may not collide) and the collision only surfaces at merge time.
    // Best-effort per repo: a sibling that can't be scanned just contributes no files.
    if (!row.isDirect) {
      try {
        const siblings = await listWorkspaceRepos(row.workspaceId, database);
        for (const repo of siblings) {
          if (!repo.worktreePath) continue;
          const repoBase = repo.baseBranch || baseBranch;
          if (!repoBase) continue;
          const ns = repo.name ?? repo.path;
          try {
            const siblingFiles = await getChangedFileNames(repo.worktreePath, repoBase);
            for (const f of siblingFiles) files.push(`${ns}::${f}`);
          } catch { /* best effort per repo */ }
        }
      } catch { /* leading-only if the sibling scan fails */ }
    }

    const ws: ContentionWorkspace = {
      workspaceId: row.workspaceId,
      issueId: row.issueId,
      issueNumber: row.issueNumber,
      issueTitle: row.issueTitle,
      branch: row.branch,
      status: row.workspaceStatus,
      issueStatus: row.issueStatus,
    };

    for (const file of files) {
      const existing = fileToWorkspaces.get(file);
      if (existing) {
        // Only add if this workspace isn't already there
        if (!existing.some((w) => w.workspaceId === row.workspaceId)) {
          existing.push(ws);
        }
      } else {
        fileToWorkspaces.set(file, [ws]);
      }
    }
  }));

  // Keep only files touched by 2+ workspaces and sort by contention count desc
  const contested: ContentionFile[] = [];
  for (const [path, wsList] of fileToWorkspaces.entries()) {
    if (wsList.length >= 2) {
      contested.push({ path, workspaces: wsList });
    }
  }
  contested.sort((a, b) => b.workspaces.length - a.workspaces.length || a.path.localeCompare(b.path));

  return {
    projectId,
    defaultBranch,
    contested,
    checkedAt: new Date().toISOString(),
  };
}
