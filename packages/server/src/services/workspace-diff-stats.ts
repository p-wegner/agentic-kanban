import { getDiffShortstat } from "./git.service.js";
import { resolveDiffRef } from "@agentic-kanban/shared/lib/git-service";

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

  const diffRef = resolveDiffRef(workspace, projectDefaultBranch);
  if (!diffRef) return null;

  return getDiffShortstat(workspace.workingDir, diffRef);
}
