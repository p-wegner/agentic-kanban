import { Hono } from "hono";
import { diffComments } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import * as gitService from "../../services/git.service.js";
import type { Database } from "../../db/index.js";
import { resolveProjectRepo, getWorkspaceById } from "../../repositories/workspace.repository.js";
import { parseDiffStats } from "../../services/board-aggregation.service.js";
import { requireBaseBranch } from "./helpers.js";

export function createGitRoutes(database: Database) {
  const router = new Hono();

  // GET /api/workspaces/:id/latest-commit — get latest commit SHA and message
  router.get("/:id/latest-commit", async (c) => {
    const id = c.req.param("id");
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    if (!workspace.workingDir) return c.json({ sha: null, message: null });
    const commit = await gitService.getLatestCommit(workspace.workingDir);
    if (!commit) return c.json({ sha: null, message: null });
    return c.json(commit);
  });

  // GET /api/workspaces/:id/diff — get git diff
  router.get("/:id/diff", async (c) => {
    const id = c.req.param("id");

    const workspace = await getWorkspaceById(id, database);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    if (!workspace.workingDir && !workspace.branch) {
      return c.json({ error: "Workspace not set up" }, 400);
    }

    try {
      let diff = "";
      let conflicts: { hasConflicts: boolean; conflictingFiles: string[] } | null = null;
      const { repoPath, defaultBranch } = await resolveProjectRepo(id, database);
      const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);

      if (workspace.isDirect) {
        diff = workspace.workingDir
          ? await gitService.getWorkingTreeDiff(workspace.workingDir)
          : "";
      } else {
        let usedWorktree = false;
        if (workspace.workingDir) {
          try {
            diff = await gitService.getDiff(workspace.workingDir, baseBranch);
            conflicts = await gitService.detectConflicts(workspace.workingDir, baseBranch);
            usedWorktree = true;
          } catch {
            // Worktree directory exists but is not a valid git repo — fall through
          }
        }
        if (!usedWorktree) {
          if (workspace.branch) {
            diff = await gitService.getDiffFromRepo(repoPath, workspace.branch, baseBranch);
          } else {
            diff = "";
          }
        }
      }
      const stats = parseDiffStats(diff);
      const comments = await database
        .select()
        .from(diffComments)
        .where(eq(diffComments.workspaceId, id));
      console.log(`[workspace-actions] diff: workspaceId=${id} isDirect=${workspace.isDirect} files=${stats.filesChanged} +${stats.insertions} -${stats.deletions} conflicts=${conflicts?.hasConflicts ?? "n/a"} comments=${comments.length}`);
      return c.json({ diff, stats, comments, conflicts });
    } catch (err) {
      return c.json(
        { error: `Diff failed: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
  });

  return router;
}
