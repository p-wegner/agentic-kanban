/**
 * Agent-question routes — surface AskUserQuestion permission denials as pending
 * questions per project, and let the user answer them (the answer is formatted
 * as a follow-up turn and posted to the agent's workspace).
 *
 * Mounted under /projects so paths resolve as:
 *   GET  /api/projects/:id/agent-questions
 *   POST /api/projects/:id/agent-questions/:toolUseId/answer
 */
import type { Database } from "../db/index.js";
import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";
import { issues } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { createWorkspaceService } from "../services/workspace.service.js";
import {
  listPendingQuestionsForProject,
  markAnswered,
  markDismissed,
  formatAnswerMessage,
  recommendQuestionsForSet,
  setCachedRecommendations,
  type AgentQuestion,
} from "../services/agent-questions.service.js";

export function createAgentQuestionsRoute(
  database: Database,
  getSessionManager: () => SessionManager,
  options?: { boardEvents?: BoardEvents },
) {
  const router = createRouter();
  const workspaceService = createWorkspaceService({
    database,
    getSessionManager,
    boardEvents: options?.boardEvents,
  });

  // GET /api/projects/:id/agent-questions — list pending questions for the project.
  router.get("/:id/agent-questions", async (c) => {
    const projectId = c.req.param("id");
    const questions = await listPendingQuestionsForProject(projectId, database);
    return c.json({ questions });
  });

  // POST /api/projects/:id/agent-questions/:toolUseId/answer
  // Body: { questions: AgentQuestion[], answers: [{ selectedLabels: string[], freeText?: string }, ...], workspaceId: string }
  router.post("/:id/agent-questions/:toolUseId/answer", async (c) => {
    const toolUseId = c.req.param("toolUseId");
    const body = await parseJsonBody<{
      questions: AgentQuestion[];
      answers: { selectedLabels: string[]; freeText?: string }[];
      workspaceId: string;
    }>(c);
    if (!body.workspaceId || !Array.isArray(body.questions) || !Array.isArray(body.answers)) {
      return c.json({ error: "workspaceId, questions[], and answers[] are required" }, 400);
    }
    const content = formatAnswerMessage(body.questions, body.answers);
    try {
      const result = await workspaceService.sendTurn(body.workspaceId, content);
      // Mark answered AFTER the turn is accepted, so a failure leaves it visible for retry.
      await markAnswered(toolUseId, database);
      if (result.type === "sent") return c.json({ ok: true, content });
      return c.json({ ok: true, sessionId: result.sessionId, resumed: true, content }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[agent-questions] failed to send answer: workspace=${body.workspaceId} ${message}`);
      return c.json({ error: message }, 500);
    }
  });

  // DELETE /api/projects/:id/agent-questions/:toolUseId
  // Dismiss a pending question. Records `{ dismissed: true, dismissedAt }` under the
  // answered pref key (keeps the row for audit) so it drops out of the pending list.
  // The corresponding workspace is intentionally NOT relaunched or notified.
  router.delete("/:id/agent-questions/:toolUseId", async (c) => {
    const toolUseId = c.req.param("toolUseId");
    const dismissedAt = new Date().toISOString();
    await markDismissed(toolUseId, dismissedAt, database);
    return c.json({ ok: true, dismissed: true, dismissedAt });
  });

  // POST /api/projects/:id/agent-questions/:toolUseId/recommend
  // Force-refresh the butler recommendation for a pending question set (bypasses cache).
  // Useful for manual re-trigger and tests. The background path inside listAgentQuestions
  // already fires recommendations automatically when none is cached, so a client usually
  // does not need to call this.
  router.post("/:id/agent-questions/:toolUseId/recommend", async (c) => {
    const projectId = c.req.param("id");
    const toolUseId = c.req.param("toolUseId");
    const sets = await listPendingQuestionsForProject(projectId, database);
    const target = sets.find((s) => s.toolUseId === toolUseId);
    if (!target) return c.json({ error: "pending question set not found" }, 404);
    try {
      // Strip any cached recommendation from the questions before recomputing.
      const bareQuestions = target.questions.map(({ recommendation: _r, ...q }) => q);
      const issueRows = await database
        .select({ description: issues.description })
        .from(issues)
        .where(eq(issues.id, target.issueId))
        .limit(1);
      const recommendations = await recommendQuestionsForSet(
        projectId,
        {
          toolUseId,
          issueId: target.issueId,
          issueNumber: target.issueNumber,
          issueTitle: target.issueTitle,
          issueDescription: issueRows[0]?.description ?? null,
          questions: bareQuestions,
        },
        database,
      );
      await setCachedRecommendations(toolUseId, recommendations, database);
      return c.json({ ok: true, recommendations });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[agent-questions] recommend failed: toolUseId=${toolUseId} ${message}`);
      return c.json({ error: message }, 500);
    }
  });

  return router;
}
