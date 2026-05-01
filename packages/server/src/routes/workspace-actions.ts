import { Hono } from "hono";
import { db } from "../db/index.js";
import { workspaces, sessions } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import * as gitService from "../services/git.service.js";
import type { SessionManager } from "../services/session.manager.js";

export function createWorkspaceActionsRoute(getSessionManager: () => SessionManager) {
  const router = new Hono();

  // POST /api/workspaces/:id/setup — create git worktree
  router.post("/:id/setup", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();

    if (!body.repoPath) {
      return c.json({ error: "repoPath is required" }, 400);
    }

    // Look up workspace
    const rows = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const workspace = rows[0];

    try {
      const worktreePath = await gitService.createWorktree(body.repoPath, workspace.branch);

      const now = new Date().toISOString();
      await db
        .update(workspaces)
        .set({ workingDir: worktreePath, updatedAt: now })
        .where(eq(workspaces.id, id));

      return c.json({ id, workingDir: worktreePath });
    } catch (err) {
      return c.json(
        { error: `Worktree setup failed: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
  });

  // POST /api/workspaces/:id/launch — start agent session
  router.post("/:id/launch", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();

    if (!body.prompt) {
      return c.json({ error: "prompt is required" }, 400);
    }

    const rows = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    try {
      const sessionId = await getSessionManager().startSession(id, body.prompt, body.agentCommand);

      const now = new Date().toISOString();
      await db.update(workspaces).set({ status: "active", updatedAt: now }).where(eq(workspaces.id, id));

      return c.json({ sessionId }, 201);
    } catch (err) {
      return c.json(
        { error: `Launch failed: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
  });

  // POST /api/workspaces/:id/stop — kill current session
  router.post("/:id/stop", async (c) => {
    const id = c.req.param("id");

    // Find running sessions for this workspace
    const runningSessions = await db
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, id));

    let stopped = false;
    for (const session of runningSessions) {
      if (session.status === "running") {
        await getSessionManager().stopSession(session.id);
        stopped = true;
      }
    }

    const now = new Date().toISOString();
    await db.update(workspaces).set({ status: "idle", updatedAt: now }).where(eq(workspaces.id, id));

    return c.json({ stopped });
  });

  // GET /api/workspaces/:id/diff — get git diff
  router.get("/:id/diff", async (c) => {
    const id = c.req.param("id");

    const rows = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const workspace = rows[0];
    if (!workspace.workingDir) {
      return c.json({ error: "Workspace not set up" }, 400);
    }

    try {
      const diff = await gitService.getDiff(workspace.workingDir);
      const stats = parseDiffStats(diff);
      return c.json({ diff, stats });
    } catch (err) {
      return c.json(
        { error: `Diff failed: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
  });

  // POST /api/workspaces/:id/merge — merge branch, cleanup, close
  router.post("/:id/merge", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();

    const rows = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const workspace = rows[0];
    const repoPath = body.repoPath;
    if (!repoPath) {
      return c.json({ error: "repoPath is required" }, 400);
    }

    try {
      const result = await gitService.mergeBranch(repoPath, workspace.branch);

      // Cleanup worktree if it exists
      if (workspace.workingDir) {
        try {
          await gitService.removeWorktree(repoPath, workspace.workingDir);
        } catch {
          // Best effort — worktree may already be removed
        }
      }

      const now = new Date().toISOString();
      await db
        .update(workspaces)
        .set({ status: "closed", workingDir: null, updatedAt: now })
        .where(eq(workspaces.id, id));

      return c.json({ id, mergeOutput: result });
    } catch (err) {
      return c.json(
        { error: `Merge failed: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
  });

  // GET /api/workspaces/:id/sessions — list sessions
  router.get("/:id/sessions", async (c) => {
    const id = c.req.param("id");

    const result = await db
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, id));

    return c.json(result);
  });

  return router;
}

/** Parse basic stats from unified diff output. */
function parseDiffStats(diff: string): { filesChanged: number; insertions: number; deletions: number } {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) {
      filesChanged++;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      insertions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }

  return { filesChanged, insertions, deletions };
}
