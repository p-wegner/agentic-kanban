import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";
import type { Database } from "../db/index.js";
import { projects, agentSkills } from "@agentic-kanban/shared/schema";
import { eq, sql, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { streamSSE } from "hono/streaming";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { getPreference, setPreference } from "../repositories/preferences.repository.js";
import {
  ensureButlerSession,
  sendButlerTurn,
  subscribeButler,
  stopButlerSession,
  getButlerSession,
} from "../services/butler-sdk.service.js";

function butlerSessionPrefKey(projectId: string): string {
  return `butler_session_${projectId}`;
}

/** Fallback butler instructions, used when the editable `butler` agent skill is absent.
 *  Kept in sync with the `butler` entry in builtin-skills.ts / seed.ts. Supports the
 *  {{projectName}}, {{repoPath}}, {{serverPort}} placeholders. */
const DEFAULT_BUTLER_PROMPT = [
  `You are the project butler for "{{projectName}}" — a persistent, warm assistant embedded in the agentic-kanban board.`,
  ``,
  `Your role:`,
  `- Answer questions about the project, codebase, and active work`,
  `- Help with quick analysis, research, and code questions`,
  `- Give status overviews of the board and active agent sessions when asked`,
  ``,
  `For anything about the board (issues, statuses, counts, workspaces, sessions), use the "agentic-kanban" MCP tools (e.g. list_issues, get_board_status, get_issue) — they are authoritative. Do NOT guess board state or scrape it via curl.`,
  ``,
  `Project location: {{repoPath}}`,
  `Board API: http://localhost:{{serverPort}}/api`,
  ``,
  `Be concise and helpful; avoid unnecessary preamble. You have full read access to the project files and standard tools.`,
].join("\n");

/**
 * Butler routes — a persistent, warm Claude assistant per project, backed by the
 * Claude Agent SDK (see butler-sdk.service.ts). Routes are mounted under /projects
 * so paths resolve as /:id/butler, /:id/butler/ensure, /:id/butler/message,
 * /:id/butler/stream.
 *
 * `getSessionManager` / `options` are accepted for signature compatibility with the
 * route factory but are not needed by the SDK-backed butler.
 */
export function createButlerRoute(
  database: Database,
  _getSessionManager: () => SessionManager,
  _options?: { boardEvents?: BoardEvents },
) {
  const router = createRouter();

  async function resolveProject(projectId: string) {
    const rows = await database.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    return rows[0] ?? null;
  }

  /** Resolve the butler's system prompt from the editable `butler` agent skill
   *  (project-scoped overrides global), falling back to DEFAULT_BUTLER_PROMPT, then
   *  substitute the {{projectName}}/{{repoPath}}/{{serverPort}} placeholders. */
  async function resolveButlerPrompt(projectId: string, projectName: string, repoPath: string): Promise<string> {
    const rows = await database
      .select({ prompt: agentSkills.prompt })
      .from(agentSkills)
      .where(sql`${agentSkills.name} = 'butler' AND (${agentSkills.projectId} = ${projectId} OR ${agentSkills.projectId} IS NULL)`)
      .orderBy(desc(agentSkills.projectId))
      .limit(1);
    const serverPort = process.env.KANBAN_SERVER_PORT || process.env.PORT || "3001";
    return (rows[0]?.prompt ?? DEFAULT_BUTLER_PROMPT)
      .replace(/\{\{projectName}}/g, projectName)
      .replace(/\{\{repoPath}}/g, repoPath)
      .replace(/\{\{serverPort}}/g, serverPort);
  }

  async function startSession(projectId: string) {
    const project = await resolveProject(projectId);
    if (!project) return null;
    const claudeProfile = (await getPreference("claude_profile", database)) || undefined;
    const resumeSessionId = (await getPreference(butlerSessionPrefKey(projectId), database)) || undefined;
    const systemPromptAppend = await resolveButlerPrompt(projectId, project.name, project.repoPath);
    const wasActive = getButlerSession(projectId).active;
    const session = ensureButlerSession({
      projectId,
      repoPath: project.repoPath,
      projectName: project.name,
      claudeProfile,
      resumeSessionId,
      systemPromptAppend,
    });
    // Persist the SDK session id (for resume across restarts) once, on first creation.
    if (!wasActive) {
      subscribeButler(projectId, (e) => {
        if (e.type === "session") void setPreference(butlerSessionPrefKey(projectId), e.sessionId, database);
      });
    }
    return session;
  }

  // GET /api/projects/:id/butler — current butler state
  router.get("/:id/butler", async (c) => {
    const projectId = c.req.param("id");
    const state = getButlerSession(projectId);
    const persisted = (await getPreference(butlerSessionPrefKey(projectId), database)) || null;
    return c.json({ active: state.active, sessionId: state.sessionId ?? persisted, contextTokens: state.contextTokens });
  });

  // GET /api/projects/:id/butler/skill — the editable butler prompt + whether a
  // project-scoped override exists (vs the global default).
  router.get("/:id/butler/skill", async (c) => {
    const projectId = c.req.param("id");
    const override = await database.select({ prompt: agentSkills.prompt }).from(agentSkills)
      .where(sql`${agentSkills.name} = 'butler' AND ${agentSkills.projectId} = ${projectId}`).limit(1);
    if (override[0]) return c.json({ prompt: override[0].prompt, isOverride: true });
    const global = await database.select({ prompt: agentSkills.prompt }).from(agentSkills)
      .where(sql`${agentSkills.name} = 'butler' AND ${agentSkills.projectId} IS NULL`).limit(1);
    return c.json({ prompt: global[0]?.prompt ?? DEFAULT_BUTLER_PROMPT, isOverride: false });
  });

  // PUT /api/projects/:id/butler/skill — upsert the project-scoped butler override.
  // An empty prompt removes the override (revert to the global default).
  router.put("/:id/butler/skill", async (c) => {
    const projectId = c.req.param("id");
    const body = await parseJsonBody<{ prompt: string }>(c);
    const existing = await database.select({ id: agentSkills.id }).from(agentSkills)
      .where(sql`${agentSkills.name} = 'butler' AND ${agentSkills.projectId} = ${projectId}`).limit(1);
    const now = new Date().toISOString();
    if (!body.prompt?.trim()) {
      if (existing[0]) await database.delete(agentSkills).where(eq(agentSkills.id, existing[0].id));
      return c.json({ ok: true, isOverride: false });
    }
    if (existing[0]) {
      await database.update(agentSkills).set({ prompt: body.prompt, updatedAt: now }).where(eq(agentSkills.id, existing[0].id));
    } else {
      await database.insert(agentSkills).values({
        id: randomUUID(), name: "butler", projectId,
        description: "Project butler behavior override", prompt: body.prompt,
        isBuiltin: false, createdAt: now, updatedAt: now,
      });
    }
    return c.json({ ok: true, isOverride: true });
  });

  // POST /api/projects/:id/butler/ensure — start the warm session if not running
  router.post("/:id/butler/ensure", async (c) => {
    const projectId = c.req.param("id");
    const session = await startSession(projectId);
    if (!session) return c.json({ error: "Project not found" }, 404);
    return c.json({ active: true, sessionId: session.sessionId ?? null }, 201);
  });

  // POST /api/projects/:id/butler/message — send a turn to the warm session
  router.post("/:id/butler/message", async (c) => {
    const projectId = c.req.param("id");
    const body = await parseJsonBody<{ content: string }>(c);
    if (!body.content?.trim()) {
      return c.json({ error: "content is required" }, 400);
    }
    if (!getButlerSession(projectId).active) {
      const session = await startSession(projectId);
      if (!session) return c.json({ error: "Project not found" }, 404);
    }
    const ok = sendButlerTurn(projectId, body.content);
    return c.json({ ok });
  });

  // POST /api/projects/:id/butler/ask — synchronous: send a turn, wait for the full
  // answer, and return it in one response. This is the primitive used by the CLI and
  // MCP tool (separate processes that cannot read the server's in-memory SSE stream).
  router.post("/:id/butler/ask", async (c) => {
    const projectId = c.req.param("id");
    const body = await parseJsonBody<{ content: string; timeoutMs?: number }>(c);
    if (!body.content?.trim()) {
      return c.json({ error: "content is required" }, 400);
    }
    if (!getButlerSession(projectId).active) {
      const session = await startSession(projectId);
      if (!session) return c.json({ error: "Project not found" }, 404);
    }
    const timeoutMs = typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? body.timeoutMs : 120_000;
    const answer = await new Promise<{ text: string; isError: boolean }>((resolve) => {
      let buf = "";
      let settled = false;
      const finish = (text: string, isError: boolean) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        resolve({ text, isError });
      };
      const unsubscribe = subscribeButler(projectId, (e) => {
        if (e.type === "text") buf += e.text;
        else if (e.type === "result") finish(e.text ?? buf, e.isError ?? false);
        else if (e.type === "error") finish(e.message, true);
      });
      const timer = setTimeout(() => finish(buf || "(timed out waiting for butler response)", true), timeoutMs);
      sendButlerTurn(projectId, body.content);
    });
    return c.json({
      sessionId: getButlerSession(projectId).sessionId ?? null,
      text: answer.text,
      isError: answer.isError,
    });
  });

  // GET /api/projects/:id/butler/stream — SSE stream of butler events
  router.get("/:id/butler/stream", (c) => {
    const projectId = c.req.param("id");
    return streamSSE(c, async (stream) => {
      const unsubscribe = subscribeButler(projectId, (e) => {
        void stream.writeSSE({ data: JSON.stringify(e) });
      });
      stream.onAbort(() => unsubscribe());
      // Hold the connection open with periodic heartbeats until the client disconnects.
      while (!c.req.raw.signal.aborted) {
        await stream.sleep(15000);
        try {
          await stream.writeSSE({ event: "ping", data: "1" });
        } catch {
          break;
        }
      }
      unsubscribe();
    });
  });

  // DELETE /api/projects/:id/butler — stop the warm session and forget the resume id.
  // Clearing the persisted session id means the NEXT ensure starts a fresh session,
  // which re-reads the (possibly customized) butler skill — so "stop butler" is how
  // users apply skill/behavior changes.
  router.delete("/:id/butler", async (c) => {
    const projectId = c.req.param("id");
    stopButlerSession(projectId);
    await setPreference(butlerSessionPrefKey(projectId), "", database);
    return c.json({ ok: true });
  });

  return router;
}
