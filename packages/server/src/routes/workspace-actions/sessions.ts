import { Hono } from "hono";
import { workspaces, sessions, issues, agentSkills } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import type { SessionManager } from "../../services/session.manager.js";
import type { Database } from "../../db/index.js";
import type { BoardEvents } from "../../services/board-events.js";
import { resolveProjectId, getWorkspaceById, updateWorkspaceStatus } from "../../repositories/workspace.repository.js";
import { loadAgentSettings, toExecutorProvider } from "../../services/agent-settings.service.js";
import { buildImplementPrompt } from "../../services/plan-mode.service.js";
import { applyWorkspaceAgentSelection } from "./helpers.js";

export function createSessionRoutes(
  getSessionManager: () => SessionManager,
  database: Database,
  options?: { boardEvents?: BoardEvents },
) {
  const router = new Hono();

  // POST /api/workspaces/:id/launch — start agent session
  router.post("/:id/launch", async (c) => {
    const id = c.req.param("id");
    let body: Record<string, unknown> = {};
    try { body = await c.req.json(); } catch { /* empty body is fine */ }

    const ws0 = await getWorkspaceById(id, database);
    if (!ws0) return c.json({ error: "Workspace not found" }, 404);

    if (!body.prompt) {
      const ws = ws0;
      const issueRows = await database
        .select({ title: issues.title, description: issues.description })
        .from(issues)
        .where(eq(issues.id, ws.issueId))
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

    const allSessions = await database
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, id));

    const running = allSessions.find(s => s.status === "running")
      ?? allSessions.filter(s => s.status === "completed" || s.status === "stopped")
           .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0];

    if (!running) {
      return c.json({ error: "No session found for this workspace" }, 404);
    }

    const result = running.status === "running"
      ? getSessionManager().sendTurn(running.id, body.content)
      : { ok: false as const, error: "Agent process has exited", stale: true };
    if (!result.ok) {
      if ((result as any).stale) {
        const wsForTurn = await getWorkspaceById(id, database);
        if (!wsForTurn) return c.json({ error: "Workspace not found" }, 404);
        const planMode = wsForTurn?.planMode ?? false;
        const { agentCommand, agentArgs, claudeProfile, profile, provider, resumeWithNewModel, permissionPromptTool } =
          applyWorkspaceAgentSelection(await loadAgentSettings(database), wsForTurn);

        const sessionId = await getSessionManager().startSession({ workspaceId: id, prompt: body.content, agentCommand, agentArgs, resumeFromId: running.id, claudeProfile, profile, provider: toExecutorProvider(provider), multiTurn: false, planMode, resumeWithNewModel, permissionPromptTool, triggerType: "chat" });
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

  // GET /api/workspaces/:id/sessions — list sessions
  router.get("/:id/sessions", async (c) => {
    const id = c.req.param("id");

    const wsSessions = await getWorkspaceById(id, database);
    const skillId = wsSessions?.skillId ?? null;
    let skillName: string | null = null;
    if (skillId) {
      const skillRows = await database
        .select({ name: agentSkills.name })
        .from(agentSkills)
        .where(eq(agentSkills.id, skillId))
        .limit(1);
      skillName = skillRows[0]?.name ?? null;
    }

    const result = await database
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, id));

    return c.json(result.map(s => ({ ...s, skillName })));
  });

  return router;
}
