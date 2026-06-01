import { getDiffShortstat } from "./git.service.js";

export interface WorkspaceDiffStatsInput {
  workingDir: string | null;
  baseBranch: string | null;
  isDirect: boolean;
  status: string;
}

export interface WorkspaceDiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export async function getWorkspaceDiffStats(
  workspace: WorkspaceDiffStatsInput,
  projectDefaultBranch: string | null,
): Promise<WorkspaceDiffStats | null> {
  if (!workspace.workingDir || workspace.status === "closed") return null;

  const baseBranch = workspace.baseBranch || projectDefaultBranch;
  const diffRef = workspace.isDirect ? "HEAD" : baseBranch;
  if (!diffRef) return null;

  return getDiffShortstat(workspace.workingDir, diffRef);
}
