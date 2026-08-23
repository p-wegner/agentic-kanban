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
import type { BoardEventSink } from "../services/board-events.js";
import { getIssueDescription } from "../repositories/issue.repository.js";
import { getWorkspaceById } from "../repositories/workspace.repository.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { answerAgentQuestionBody } from "./agent-question-body-schemas.js";
import { createWorkspaceService } from "../services/workspace.service.js";
import {
  listPendingQuestionsForProject,
  markAnswered,
  markDismissed,
  formatAnswerMessage,
  writeAgentQuestionComment,
  recommendQuestionsForSet,
  setCachedRecommendations,
} from "../services/agent-questions.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

export function createAgentQuestionsRoute(
  database: Database,
  getSessionManager: () => SessionManager,
  options?: { boardEvents?: BoardEventSink },
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
    const questions = await listPendingQuestionsForProject(projectId, database, async (workspaceId, content) => {
      await workspaceService.sendTurn(workspaceId, content);
    });
    return c.json({ questions });
  });

  // POST /api/projects/:id/agent-questions/:toolUseId/answer
  // Body: { questions: AgentQuestion[], answers: [{ selectedLabels: string[], freeText?: string }, ...], workspaceId: string }
  router.post("/:id/agent-questions/:toolUseId/answer", async (c) => {
    const projectId = c.req.param("id");
    const toolUseId = c.req.param("toolUseId");
    const body = await parseJsonBody(c, answerAgentQuestionBody);
    // Dead workspace (seen on issue #656): refuse early when the asking workspace can no
    // longer take a turn. A closed workspace (or one whose worktree is gone) makes
    // sendTurn fail deep inside the session manager with the bare
    // "Workspace has no working directory; run setup first" — a
    // message that reads like a setup step the user could take, when in fact the only
    // way out is to dismiss the question. `canDismiss` lets the UI say exactly that.
    const workspace = await getWorkspaceById(body.workspaceId, database);
    const gone = !workspace ? "deleted" : workspace.status === "closed" ? "closed" : !workspace.workingDir ? "unbuilt" : null;
    if (gone) {
      return c.json({
        error: gone === "unbuilt"
          ? "The workspace that asked this question has no working directory, so the agent " +
            "cannot be resumed. Run setup on the workspace, or dismiss the question."
          : `The workspace that asked this question is ${gone} — the agent is gone and cannot ` +
            "receive an answer. Dismiss the question instead (and re-ask on a fresh workspace " +
            "if the decision still matters).",
        canDismiss: true,
      }, 409);
    }
    const content = formatAnswerMessage(body.questions, body.answers);
    try {
      const result = await workspaceService.sendTurn(body.workspaceId, content);
      // Mark answered AFTER the turn is accepted, so a failure leaves it visible for retry.
      await markAnswered(toolUseId, database, projectId);
      // Persist the Q&A as durable ticket history (best-effort).
      await writeAgentQuestionComment(
        { toolUseId, workspaceId: body.workspaceId, questions: body.questions, answers: body.answers, body: content, author: "user" },
        database,
      );
      if (result.type === "sent") return c.json({ ok: true, content });
      return c.json({ ok: true, sessionId: result.sessionId, resumed: true, content }, 201);
    } catch (err) {
      const message = errorMessage(err);
      console.error(`[agent-questions] failed to send answer: workspace=${body.workspaceId} ${message}`);
      return c.json({ error: message }, 500);
    }
  });

  // DELETE /api/projects/:id/agent-questions/:toolUseId
  // Dismiss a pending question. Records `{ dismissed: true, dismissedAt }` under the
  // answered pref key (keeps the row for audit) so it drops out of the pending list.
  // The corresponding workspace is intentionally NOT relaunched or notified.
  router.delete("/:id/agent-questions/:toolUseId", async (c) => {
    const projectId = c.req.param("id");
    const toolUseId = c.req.param("toolUseId");
    const dismissedAt = new Date().toISOString();
    await markDismissed(toolUseId, dismissedAt, database, projectId);
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
      const issueRow = await getIssueDescription(target.issueId, database);
      const recommendations = await recommendQuestionsForSet(
        projectId,
        {
          toolUseId,
          issueId: target.issueId,
          issueNumber: target.issueNumber,
          issueTitle: target.issueTitle,
          issueDescription: issueRow?.description ?? null,
          questions: bareQuestions,
        },
        database,
      );
      await setCachedRecommendations(toolUseId, recommendations, database, projectId);
      return c.json({ ok: true, recommendations });
    } catch (err) {
      const message = errorMessage(err);
      console.error(`[agent-questions] recommend failed: toolUseId=${toolUseId} ${message}`);
      return c.json({ error: message }, 500);
    }
  });

  return router;
}
