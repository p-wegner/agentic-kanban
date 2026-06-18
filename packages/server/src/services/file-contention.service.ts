import type { Database } from "../db/index.js";
import { getChangedFileNames } from "./git.service.js";
import { getProjectDefaultBranch, getActiveContentionWorkspaces } from "../repositories/file-contention.repository.js";

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
    throw new Error(`Project not found: ${projectId}`);
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
