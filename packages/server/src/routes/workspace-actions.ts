import { Hono } from "hono";
import { db } from "../db/index.js";
import { workspaces, sessions, issues, projects, preferences, diffComments, projectStatuses } from "@agentic-kanban/shared/schema";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as gitService from "../services/git.service.js";
import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";
import type { Database } from "../db/index.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = resolve(__dirname, "../scripts/mock-agent.ts");
// Resolve tsx from server's node_modules so the mock agent works from any CWD (e.g. worktrees)
const TSX_LOADER = resolve(__dirname, "../../node_modules/tsx/dist/loader.mjs");
const TSX_URL = pathToFileURL(TSX_LOADER).href;
const MOCK_AGENT_COMMAND = `node --import ${TSX_URL} "${MOCK_AGENT_PATH}"`;

/**
 * Resolve repo info from workspace → issue → project chain.
 */
async function resolveProjectRepo(
  workspaceId: string,
  database: Database = db,
): Promise<{ repoPath: string; defaultBranch: string }> {
  const wsRows = await database
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (wsRows.length === 0) {
    throw new Error("Workspace not found");
  }

  const issueRows = await database
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, wsRows[0].issueId))
    .limit(1);
  if (issueRows.length === 0) {
    throw new Error("Issue not found");
  }

  const projectRows = await database
    .select({ repoPath: projects.repoPath, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, issueRows[0].projectId))
    .limit(1);
  if (projectRows.length === 0) {
    throw new Error("Project not found");
  }

  return {
    repoPath: projectRows[0].repoPath,
    defaultBranch: projectRows[0].defaultBranch,
  };
}

async function resolveProjectId(
  workspaceId: string,
  database: Database = db,
): Promise<string | null> {
  const wsRows = await database.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (wsRows.length === 0) return null;
  const issueRows = await database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, wsRows[0].issueId)).limit(1);
  if (issueRows.length === 0) return null;
  return issueRows[0].projectId;
}

export function createWorkspaceActionsRoute(
  getSessionManager: () => SessionManager,
  database: Database = db,
  options?: { boardEvents?: BoardEvents },
) {
  const router = new Hono();

  // POST /api/workspaces/:id/setup — create git worktree (no-op if already set up)
  router.post("/:id/setup", async (c) => {
    const id = c.req.param("id");

    // Look up workspace
    const rows = await database.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const workspace = rows[0];

    // Already set up — return existing info
    if (workspace.workingDir) {
      return c.json({ id, workingDir: workspace.workingDir });
    }

    try {
      const { repoPath, defaultBranch } = await resolveProjectRepo(id, database);
      const baseBranch = workspace.baseBranch || defaultBranch;
      console.log(`[workspace-actions] setup: workspaceId=${id} branch=${workspace.branch} repoPath=${repoPath} baseBranch=${baseBranch}`);

      const worktreePath = await gitService.createWorktree(repoPath, workspace.branch, baseBranch);
      console.log(`[workspace-actions] setup complete: workspaceId=${id} worktreePath=${worktreePath}`);

      const now = new Date().toISOString();
      await database
        .update(workspaces)
        .set({ workingDir: worktreePath, baseBranch, updatedAt: now })
        .where(eq(workspaces.id, id));

      // Broadcast board event
      const projectId = await resolveProjectId(id, database);
      if (projectId) options?.boardEvents?.broadcast(projectId, "workspace_setup");

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

    const rows = await database.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    try {
      // Read agent settings from preferences
      const prefRows = await database.select().from(preferences);
      const prefMap = new Map(prefRows.map(r => [r.key, r.value]));

      // Determine agent command: explicit body > mock_agent pref / env > agent_command pref > default
      let agentCommand = body.agentCommand || undefined;
      if (!agentCommand) {
        const useMock = prefMap.get("mock_agent") === "true" || process.env.MOCK_AGENT === "1";
        if (useMock) {
          agentCommand = MOCK_AGENT_COMMAND;
        } else {
          agentCommand = prefMap.get("agent_command") || undefined;
        }
      }
      const skipPerms = prefMap.get("skip_permissions") === "true";
      const baseArgs = prefMap.get("agent_args") || "";
      const agentArgs = skipPerms
        ? (baseArgs ? baseArgs + " --dangerously-skip-permissions" : "--dangerously-skip-permissions")
        : (baseArgs || undefined);

      const truncatedPrompt = body.prompt.length > 80 ? body.prompt.slice(0, 80) + "..." : body.prompt;
      console.log(`[workspace-actions] launch: workspaceId=${id} prompt="${truncatedPrompt}" agentCommand=${agentCommand ?? "default"} agentArgs=${agentArgs ?? "none"} resumeFromId=${body.resumeFromId ?? "none"}`);
      const sessionId = await getSessionManager().startSession(id, body.prompt, agentCommand, agentArgs, body.resumeFromId);

      const now = new Date().toISOString();
      await database.update(workspaces).set({ status: "active", updatedAt: now }).where(eq(workspaces.id, id));

      // Broadcast board event
      const projectId = await resolveProjectId(id, database);
      if (projectId) options?.boardEvents?.broadcast(projectId, "session_launched");

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
    console.log(`[workspace-actions] stop: workspaceId=${id}`);

    // Find running sessions for this workspace
    const runningSessions = await database
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
    await database.update(workspaces).set({ status: "idle", updatedAt: now }).where(eq(workspaces.id, id));

    // Broadcast board event
    const projectId = await resolveProjectId(id, database);
    if (projectId) options?.boardEvents?.broadcast(projectId, "session_stopped");

    return c.json({ stopped });
  });

  // GET /api/workspaces/:id/diff — get git diff
  router.get("/:id/diff", async (c) => {
    const id = c.req.param("id");

    const rows = await database.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const workspace = rows[0];
    if (!workspace.workingDir) {
      return c.json({ error: "Workspace not set up" }, 400);
    }

    try {
      let diff: string;
      if (workspace.isDirect) {
        diff = await gitService.getWorkingTreeDiff(workspace.workingDir);
      } else {
        const { defaultBranch } = await resolveProjectRepo(id, database);
        const baseBranch = workspace.baseBranch || defaultBranch;
        diff = await gitService.getDiff(workspace.workingDir, baseBranch);
      }
      const stats = parseDiffStats(diff);
      const comments = await database
        .select()
        .from(diffComments)
        .where(eq(diffComments.workspaceId, id));
      console.log(`[workspace-actions] diff: workspaceId=${id} isDirect=${workspace.isDirect} files=${stats.filesChanged} +${stats.insertions} -${stats.deletions} comments=${comments.length}`);
      return c.json({ diff, stats, comments });
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

    const rows = await database.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const workspace = rows[0];

    try {
      // Direct workspace: no merge needed, just close
      if (workspace.isDirect) {
        const now = new Date().toISOString();
        await database
          .update(workspaces)
          .set({ status: "closed", updatedAt: now })
          .where(eq(workspaces.id, id));

        // Auto-move issue to "Done"
        try {
          const projectId = await resolveProjectId(id, database);
          if (projectId) {
            const statuses = await database.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
            const doneStatus = statuses.find(s => s.name === "Done");
            if (doneStatus) {
              await database.update(issues).set({ statusId: doneStatus.id, updatedAt: now }).where(eq(issues.id, workspace.issueId));
            }
          }
        } catch (err) {
          console.warn("[workspaces] Failed to move issue to Done:", err);
        }

        const projectId = await resolveProjectId(id, database);
        if (projectId) options?.boardEvents?.broadcast(projectId, "workspace_merged");

        return c.json({ id, mergeOutput: "Direct workspace closed (no merge needed)" });
      }

      const { repoPath } = await resolveProjectRepo(id, database);
      console.log(`[workspace-actions] merge: workspaceId=${id} branch=${workspace.branch} repoPath=${repoPath}`);
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
      await database
        .update(workspaces)
        .set({ status: "closed", workingDir: null, updatedAt: now })
        .where(eq(workspaces.id, id));

      // Auto-move issue to "Done"
      try {
        const projectId = await resolveProjectId(id, database);
        if (projectId) {
          const statuses = await database.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
          const doneStatus = statuses.find(s => s.name === "Done");
          if (doneStatus) {
            await database.update(issues).set({ statusId: doneStatus.id, updatedAt: now }).where(eq(issues.id, workspace.issueId));
          }
        }
      } catch (err) {
        console.warn("[workspaces] Failed to move issue to Done:", err);
      }

      // Broadcast board event
      const projectId = await resolveProjectId(id, database);
      if (projectId) options?.boardEvents?.broadcast(projectId, "workspace_merged");

      return c.json({ id, mergeOutput: result });
    } catch (err) {
      return c.json(
        { error: `Merge failed: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
  });

  // GET /api/workspaces/:id/comments — list diff comments
  router.get("/:id/comments", async (c) => {
    const id = c.req.param("id");
    const filePath = c.req.query("filePath");

    const conditions = [eq(diffComments.workspaceId, id)];
    if (filePath) {
      conditions.push(eq(diffComments.filePath, filePath));
    }

    const result = await database
      .select()
      .from(diffComments)
      .where(and(...conditions));
    return c.json(result);
  });

  // POST /api/workspaces/:id/comments — create diff comment
  router.post("/:id/comments", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();

    if (!body.filePath || !body.body) {
      return c.json({ error: "filePath and body are required" }, 400);
    }

    const wsRows = await database.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (wsRows.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const now = new Date().toISOString();
    const comment = {
      id: randomUUID(),
      workspaceId: id,
      filePath: body.filePath,
      lineNumOld: body.lineNumOld ?? null,
      lineNumNew: body.lineNumNew ?? null,
      side: body.side || "new",
      body: body.body,
      createdAt: now,
      updatedAt: now,
    };

    await database.insert(diffComments).values(comment);
    return c.json(comment, 201);
  });

  // PATCH /api/workspaces/:id/comments/:commentId — update diff comment
  router.patch("/:id/comments/:commentId", async (c) => {
    const id = c.req.param("id");
    const commentId = c.req.param("commentId");
    const body = await c.req.json();

    if (!body.body) {
      return c.json({ error: "body is required" }, 400);
    }

    const rows = await database
      .select()
      .from(diffComments)
      .where(and(eq(diffComments.id, commentId), eq(diffComments.workspaceId, id)))
      .limit(1);

    if (rows.length === 0) {
      return c.json({ error: "Comment not found" }, 404);
    }

    const now = new Date().toISOString();
    await database
      .update(diffComments)
      .set({ body: body.body, updatedAt: now })
      .where(eq(diffComments.id, commentId));

    return c.json({ id: commentId });
  });

  // DELETE /api/workspaces/:id/comments/:commentId — delete diff comment
  router.delete("/:id/comments/:commentId", async (c) => {
    const id = c.req.param("id");
    const commentId = c.req.param("commentId");

    const rows = await database
      .select()
      .from(diffComments)
      .where(and(eq(diffComments.id, commentId), eq(diffComments.workspaceId, id)))
      .limit(1);

    if (rows.length === 0) {
      return c.json({ error: "Comment not found" }, 404);
    }

    await database.delete(diffComments).where(eq(diffComments.id, commentId));
    return c.json({ success: true });
  });

  // GET /api/workspaces/:id/sessions — list sessions
  router.get("/:id/sessions", async (c) => {
    const id = c.req.param("id");

    const result = await database
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
