import { workspaces, issues, projectStatuses, projects } from "@agentic-kanban/shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { getChangedFileNames } from "./git.service.js";

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
  const projectRows = await database
    .select({ id: projects.id, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (projectRows.length === 0) {
    throw new Error(`Project not found: ${projectId}`);
  }
  const defaultBranch = projectRows[0].defaultBranch;

  // Load active workspaces for this project with issue info
  const rows = await database
    .select({
      workspaceId: workspaces.id,
      branch: workspaces.branch,
      workingDir: workspaces.workingDir,
      baseBranch: workspaces.baseBranch,
      isDirect: workspaces.isDirect,
      workspaceStatus: workspaces.status,
      issueId: issues.id,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
      issueStatus: projectStatuses.name,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(
      and(
        eq(issues.projectId, projectId),
        inArray(workspaces.status, [...ACTIVE_STATUSES]),
      ),
    );

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
