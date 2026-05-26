import { Hono } from "hono";
import { db } from "../db/index.js";
import { workspaces, sessions, issues, preferences, diffComments, agentSkills } from "@agentic-kanban/shared/schema";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";
import type { Database } from "../db/index.js";
import { getWorkspaceById, resolveProjectId, updateWorkspaceStatus } from "../repositories/workspace.repository.js";
import { loadAgentSettings, toExecutorProvider, type AgentSettings } from "../services/agent-settings.service.js";
import { buildImplementPrompt } from "../services/plan-mode.service.js";
import { createWorkspaceService, WorkspaceError } from "../services/workspace.service.js";
import type { ProviderName } from "../services/agent-provider.js";
import {
  findResumableSession,
  getWorkspaceSessions,
  getDiffComments,
  createDiffComment,
  updateDiffComment,
  findDiffComment,
  deleteDiffComment,
  getWorkspaceSkillName,
} from "../repositories/session.repository.js";

function applyWorkspaceAgentSelection(settings: AgentSettings, workspace: typeof workspaces.$inferSelect): AgentSettings {
  const provider = workspace.provider;
  if (provider !== "claude" && provider !== "codex" && provider !== "copilot") return settings;

  const profileName = workspace.claudeProfile || undefined;
  const agentArgs = provider === "claude"
    ? settings.agentArgs
    : settings.agentArgs
      ?.split(/\s+/)
      .filter((arg) => arg && arg !== "--dangerously-skip-permissions")
      .join(" ") || undefined;
  return {
    ...settings,
    agentArgs,
    provider,
    claudeProfile: provider === "claude" ? profileName : undefined,
    profile: profileName ? { provider: provider as ProviderName, name: profileName } : undefined,
  };
}

export function createWorkspaceActionsRoute(
  getSessionManager: () => SessionManager,
  database: Database = db,
  options?: { boardEvents?: BoardEvents; fixAndMergeSessionIds?: Set<string> },
) {
  const router = new Hono();

  const workspaceService = createWorkspaceService({
    database,
    getSessionManager,
    boardEvents: options?.boardEvents,
  });

  // POST /api/workspaces/:id/setup — create git worktree (no-op if already set up)
  router.post("/:id/setup", async (c) => {
    const id = c.req.param("id");
    try {
      const result = await workspaceService.setupWorkspace(id);
      return c.json(result);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        const code = err.code === "NOT_FOUND" ? 404 : 500;
        return c.json({ error: err.message }, code);
      }
      return c.json({ error: `Worktree setup failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/workspaces/:id/terminal — open a terminal in the workspace directory
  router.post("/:id/terminal", async (c) => {
    const id = c.req.param("id");

    const workspace = await getWorkspaceById(id, database);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    if (!workspace.workingDir) {
      return c.json({ error: "Workspace not set up" }, 400);
    }

    try {
      const { agentCommand, agentArgs } = await loadAgentSettings(database);
      const resolvedCommand = agentCommand || "claude";
      const fullCommand = agentArgs ? `${resolvedCommand} ${agentArgs}` : resolvedCommand;

      if (process.platform === "win32") {
        const tmpScript = join(tmpdir(), `terminal-${id}.cmd`);
        writeFileSync(tmpScript, `@cd /d "${workspace.workingDir}"\r\n@${fullCommand}\r\n`);
        spawn("cmd.exe", ["/c", "start", `Terminal - ${workspace.branch}`, tmpScript], {
          detached: true,
          stdio: "ignore",
        }).unref();
      } else {
        spawn("x-terminal-emulator", [
          "-e", `bash -c 'cd "${workspace.workingDir}" && ${fullCommand}; exec bash'`,
        ], {
          detached: true,
          stdio: "ignore",
        }).unref();
      }

      console.log(`[workspace-actions] terminal: workspaceId=${id} workingDir=${workspace.workingDir} command=${fullCommand}`);
      return c.json({ ok: true, workingDir: workspace.workingDir, command: fullCommand });
    } catch (err) {
      return c.json(
        { error: `Terminal launch failed: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
  });

  // POST /api/workspaces/:id/launch — start agent session
  router.post("/:id/launch", async (c) => {
    const id = c.req.param("id");
    let body: Record<string, unknown> = {};
    try { body = await c.req.json(); } catch { /* empty body is fine */ }

    const ws0 = await getWorkspaceById(id, database);
    if (!ws0) return c.json({ error: "Workspace not found" }, 404);

    // Auto-build prompt from issue when not provided
    if (!body.prompt) {
      const issueRows = await database
        .select({ title: issues.title, description: issues.description })
        .from(issues)
        .where(eq(issues.id, ws0.issueId))
        .limit(1);
      if (issueRows.length === 0) {
        return c.json({ error: "prompt is required" }, 400);
      }
      const iss = issueRows[0];
      body = { ...body, prompt: iss.description ? `${iss.title}\n\n${iss.description}` : iss.title };
    }

    try {
      const { agentCommand, agentArgs, claudeProfile, profile: agentProfile, provider: agentProvider, resumeWithNewModel, permissionPromptTool } =
        applyWorkspaceAgentSelection(await loadAgentSettings(database, body.agentCommand as string | undefined), ws0);

      const promptStr = body.prompt as string;
      const truncatedPrompt = promptStr.length > 80 ? promptStr.slice(0, 80) + "..." : promptStr;

      const skipPermissions = typeof body.skipPermissions === "boolean" ? body.skipPermissions : undefined;

      console.log(`[workspace-actions] launch: workspaceId=${id} prompt="${truncatedPrompt}" agentCommand=${agentCommand ?? "default"} agentArgs=${agentArgs ?? "none"} profile=${claudeProfile ?? "none"} resumeFromId=${body.resumeFromId ?? "none"} resumeWithNewModel=${resumeWithNewModel} skipPermissions=${skipPermissions ?? "default"}`);

      const planMode = ws0.planMode ?? false;

      const resumeFromId = typeof body.resumeFromId === "string" ? body.resumeFromId : undefined;
      const sessionId = await getSessionManager().startSession({ workspaceId: id, prompt: promptStr, agentCommand, agentArgs, resumeFromId, claudeProfile, provider: toExecutorProvider(agentProvider), multiTurn: false, permissionPromptTool, planMode, resumeWithNewModel, triggerType: "chat", profile: agentProfile, skipPermissions });

      await updateWorkspaceStatus(id, "active", { claudeProfile: claudeProfile ?? null, agentCommand: agentCommand ?? null, provider: agentProvider }, database);

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

  // POST /api/workspaces/:id/turn — send follow-up message to active session (multi-turn)
  router.post("/:id/turn", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();

    if (!body.content) {
      return c.json({ error: "content is required" }, 400);
    }

    const resumable = await findResumableSession(id, database);
    if (!resumable) {
      return c.json({ error: "No session found for this workspace" }, 404);
    }

    const result = resumable.session.status === "running"
      ? getSessionManager().sendTurn(resumable.session.id, body.content)
      : { ok: false as const, error: "Agent process has exited", stale: true };

    if (!result.ok) {
      if ((result as any).stale) {
        const wsForTurn = await getWorkspaceById(id, database);
        if (!wsForTurn) return c.json({ error: "Workspace not found" }, 404);
        const planMode = wsForTurn?.planMode ?? false;
        const { agentCommand, agentArgs, claudeProfile, profile, provider, resumeWithNewModel, permissionPromptTool } =
          applyWorkspaceAgentSelection(await loadAgentSettings(database), wsForTurn);

        const sessionId = await getSessionManager().startSession({ workspaceId: id, prompt: body.content, agentCommand, agentArgs, resumeFromId: resumable.session.id, claudeProfile, profile, provider: toExecutorProvider(provider), multiTurn: false, planMode, resumeWithNewModel, permissionPromptTool, triggerType: "chat" });
        await updateWorkspaceStatus(id, "active", { claudeProfile: claudeProfile ?? null, agentCommand: agentCommand ?? null, provider: provider }, database);
        const projectId = await resolveProjectId(id, database);
        if (projectId) options?.boardEvents?.broadcast(projectId, "session_launched");
        return c.json({ sessionId, resumed: true }, 201);
      }
      return c.json({ error: result.error }, 409);
    }

    return c.json({ ok: true });
  });

  // POST /api/workspaces/:id/stop — kill current session
  router.post("/:id/stop", async (c) => {
    const id = c.req.param("id");
    console.log(`[workspace-actions] stop: workspaceId=${id}`);

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

    await updateWorkspaceStatus(id, "idle", {}, database);

    const projectId = await resolveProjectId(id, database);
    if (projectId) options?.boardEvents?.broadcast(projectId, "session_stopped");

    return c.json({ stopped });
  });

  // POST /api/workspaces/:id/implement-plan — accept a pending plan and start implementation
  router.post("/:id/implement-plan", async (c) => {
    const id = c.req.param("id");
    const ws0 = await getWorkspaceById(id, database);
    if (!ws0) return c.json({ error: "Workspace not found" }, 404);
    if (!ws0.pendingPlanPath) return c.json({ error: "No pending plan to implement" }, 409);

    try {
      const { agentCommand, agentArgs, claudeProfile, profile: agentProfile, provider: agentProvider, permissionPromptTool } =
        applyWorkspaceAgentSelection(await loadAgentSettings(database, undefined), ws0);

      const sessionId = await getSessionManager().startSession({
        workspaceId: id,
        prompt: buildImplementPrompt(),
        agentCommand,
        agentArgs,
        claudeProfile,
        provider: toExecutorProvider(agentProvider),
        multiTurn: false,
        permissionPromptTool,
        planMode: false,
        triggerType: "plan-implement",
        profile: agentProfile,
      });

      const now = new Date().toISOString();
      await database.update(workspaces).set({ status: "active", pendingPlanPath: null, claudeProfile: claudeProfile ?? null, agentCommand: agentCommand ?? null, provider: agentProvider, updatedAt: now }).where(eq(workspaces.id, id));

      const projectId = await resolveProjectId(id, database);
      if (projectId) options?.boardEvents?.broadcast(projectId, "session_launched");

      return c.json({ sessionId }, 201);
    } catch (err) {
      return c.json({ error: `Implement-plan failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // GET /api/workspaces/:id/latest-commit
  router.get("/:id/latest-commit", async (c) => {
    const id = c.req.param("id");
    try {
      const result = await workspaceService.getLatestCommit(id);
      return c.json(result);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
  });

  // GET /api/workspaces/:id/diff — get git diff
  router.get("/:id/diff", async (c) => {
    const id = c.req.param("id");
    try {
      const result = await workspaceService.getWorkspaceDiff(id);
      return c.json(result);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        const code = err.code === "NOT_FOUND" ? 404 : 400;
        return c.json({ error: err.message }, code);
      }
      return c.json({ error: `Diff failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/workspaces/:id/merge — merge branch, cleanup, close
  router.post("/:id/merge", async (c) => {
    const id = c.req.param("id");
    try {
      const result = await workspaceService.mergeWorkspace(id);
      return c.json(result);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        if (err.data?.conflictingFiles) {
          return c.json({ error: "Merge conflicts detected", conflictingFiles: err.data.conflictingFiles }, 409);
        }
        const code = err.code === "NOT_FOUND" ? 404 : 500;
        return c.json({ error: err.message }, code);
      }
      return c.json({ error: `Merge failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // GET /api/workspaces/:id/conflicts — on-demand conflict detection
  router.get("/:id/conflicts", async (c) => {
    const id = c.req.param("id");
    try {
      const result = await workspaceService.getConflicts(id);
      return c.json(result);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        return c.json({ error: err.message }, 404);
      }
      return c.json({ error: `Conflict detection failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/workspaces/:id/update-base — rebase or merge base branch into workspace
  router.post("/:id/update-base", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const mode = body.mode === "merge" ? "merge" as const : "rebase" as const;

    try {
      const result = await workspaceService.updateBase(id, mode);
      return c.json(result);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        const code = err.code === "NOT_FOUND" ? 404 : 400;
        return c.json({ error: err.message }, code);
      }
      return c.json({ error: `Update base failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/workspaces/:id/abort-rebase — abort in-progress rebase
  router.post("/:id/abort-rebase", async (c) => {
    const id = c.req.param("id");
    try {
      const result = await workspaceService.abortRebase(id);
      return c.json(result);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        const code = err.code === "NOT_FOUND" ? 404 : 400;
        return c.json({ error: err.message }, code);
      }
      return c.json({ error: `Abort rebase failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/workspaces/:id/resolve-conflicts — launch AI agent to resolve conflicts
  router.post("/:id/resolve-conflicts", async (c) => {
    const id = c.req.param("id");
    try {
      const result = await workspaceService.resolveConflicts(id);
      options?.fixAndMergeSessionIds?.add(result.sessionId);
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        const code = err.code === "NOT_FOUND" ? 404 : err.message.includes("already in progress") ? 409 : 400;
        return c.json({ error: err.message }, code);
      }
      return c.json({ error: `Resolve conflicts failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/workspaces/:id/fix-and-merge — launch AI agent to fix merge error and retry
  router.post("/:id/fix-and-merge", async (c) => {
    const id = c.req.param("id");
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    if (!workspace.workingDir) {
      return c.json({ error: "Workspace not set up" }, 400);
    }
    if (workspace.status === "fixing") {
      return c.json({ error: "Fix already in progress" }, 409);
    }

    try {
      const body: { mergeError?: string } = await c.req.json<{ mergeError?: string }>().catch(() => ({}));
      const result = await workspaceService.fixAndMerge(id, body.mergeError);
      options?.fixAndMergeSessionIds?.add(result.sessionId);
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        const code = err.code === "NOT_FOUND" ? 404 : 400;
        return c.json({ error: err.message }, code);
      }
      return c.json({ error: `Fix-and-merge failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // GET /api/workspaces/:id/comments — list diff comments
  router.get("/:id/comments", async (c) => {
    const id = c.req.param("id");
    const filePath = c.req.query("filePath");
    const result = await getDiffComments(id, filePath, database);
    return c.json(result);
  });

  // POST /api/workspaces/:id/comments — create diff comment
  router.post("/:id/comments", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();

    if (!body.filePath || !body.body) {
      return c.json({ error: "filePath and body are required" }, 400);
    }

    const wsCheck = await getWorkspaceById(id, database);
    if (!wsCheck) return c.json({ error: "Workspace not found" }, 404);

    const comment = await createDiffComment(id, body, database);
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

    const existing = await findDiffComment(commentId, id, database);
    if (!existing) {
      return c.json({ error: "Comment not found" }, 404);
    }

    await updateDiffComment(commentId, body.body, database);
    return c.json({ id: commentId });
  });

  // DELETE /api/workspaces/:id/comments/:commentId — delete diff comment
  router.delete("/:id/comments/:commentId", async (c) => {
    const id = c.req.param("id");
    const commentId = c.req.param("commentId");

    const existing = await findDiffComment(commentId, id, database);
    if (!existing) {
      return c.json({ error: "Comment not found" }, 404);
    }

    await deleteDiffComment(commentId, database);
    return c.json({ success: true });
  });

  // GET /api/workspaces/:id/sessions — list sessions
  router.get("/:id/sessions", async (c) => {
    const id = c.req.param("id");

    const ws = await getWorkspaceById(id, database);
    const skillName = await getWorkspaceSkillName(ws?.skillId ?? null, database);

    const result = await getWorkspaceSessions(id, database);
    return c.json(result.map(s => ({ ...s, skillName })));
  });

  // POST /api/workspaces/:id/open-editor — open the workspace directory in VS Code
  router.post("/:id/open-editor", async (c) => {
    const id = c.req.param("id");

    const ws = await getWorkspaceById(id, database);
    if (!ws) return c.json({ error: "Workspace not found" }, 404);

    const { workingDir } = ws;
    if (!workingDir) return c.json({ error: "Workspace has no working directory" }, 422);

    const which = spawnSync("code", ["--version"], { shell: true, windowsHide: true });
    if (which.status !== 0) {
      return c.json({ error: "VS Code (code) is not installed or not in PATH" }, 422);
    }

    spawn("code", [workingDir], { shell: true, windowsHide: true, detached: true }).unref();

    return c.json({ ok: true });
  });

  return router;
}
