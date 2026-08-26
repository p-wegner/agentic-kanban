import type { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import type { UpgradeWebSocket } from "hono/ws";
import { db } from "../db/index.js";
import { createBoardEvents } from "../services/board-events.js";
import { createSessionManager } from "../services/session.manager.js";
import { createWorkflowEngine } from "./exit-workflow.js";
import { createWorkflowForkService } from "../services/workflow-fork.service.js";
import { createAutoMerge } from "./merge-workflow.js";
import { invalidateAgentQuestionsCache } from "../services/agent-questions.service.js";
import { attachButlerEventFeed } from "../services/butler-event-feed.js";
import { getButlerSession, sendButlerTurn } from "../services/butler-sdk.service.js";
import { getPreference } from "../repositories/preferences.repository.js";

export interface CoreServicesWiring {
  injectWebSocket: ReturnType<typeof createNodeWebSocket>["injectWebSocket"];
  upgradeWebSocket: UpgradeWebSocket;
  boardEvents: ReturnType<typeof createBoardEvents>;
  sessionManager: ReturnType<typeof createSessionManager>;
  workflow: ReturnType<typeof createWorkflowEngine>;
  forkService: ReturnType<typeof createWorkflowForkService>;
  autoMerge: ReturnType<typeof createAutoMerge>;
}

/**
 * Wires the websocket upgrade hook, board-events bus, butler event feed, session
 * manager and the exit-workflow/auto-merge/fork-service triangle together —
 * extracted from `server-start.ts` (#873). This is the part of startup with the
 * most fan-out and the tightest mutual references (workflow needs autoMerge,
 * autoMerge needs workflow's `learningSessionIds`, sessionManager needs the
 * workflow's exit hook), so it stays one function rather than being split
 * further — splitting it would just relocate the coupling, not reduce it.
 */
export function wireCoreServices(app: Hono): CoreServicesWiring {
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const boardEvents = createBoardEvents();
  boardEvents.startCleanup();
  // Keep the agent-questions response cache correct: any board event for a
  // project (session exit, workspace status change, MCP comment notify, ...)
  // drops that project's cached pending-questions listing.
  boardEvents.addInvalidationListener((projectId) => invalidateAgentQuestionsCache(projectId));
  // The butler system-event feed (#561): the only place it learns about the DB and
  // the butler-session registry. Unattached it is inert, which is what keeps it out
  // of every test that merely runs code emitting an event.
  attachButlerEventFeed({
    readPreference: (key) => getPreference(key, db),
    isButlerActive: (projectId) => getButlerSession(projectId).active,
    sendTurn: (projectId, text) => sendButlerTurn(projectId, text),
  });

  let runWorkflowOnExit: ReturnType<typeof createWorkflowEngine>["runWorkflowOnExit"] = async () => {};
  let autoMerge: ReturnType<typeof createAutoMerge> = async () => {};
  const sessionManager = createSessionManager(upgradeWebSocket, {
    onSessionExit: (workspaceId, sessionId, exitCode, wasPlanMode) => {
      runWorkflowOnExit(workspaceId, sessionId, exitCode, wasPlanMode).catch((err) => console.error("[fatal] runWorkflowOnExit unhandled:", err));
    },
    onActivity: (projectId, issueId, sessionId, activity) => boardEvents.broadcastActivity(projectId, { issueId, sessionId, activity }),
    onLiveStats: (projectId, issueId, model, contextTokens, toolUses, subagentCount) => boardEvents.broadcastLiveStats(projectId, issueId, model, contextTokens, toolUses, subagentCount),
    onTodos: (projectId, issueId, todos) => boardEvents.broadcastTodos(projectId, issueId, todos),
  });

  // Shared with route-setup's internal /workflow-advanced handler (#1000): the
  // exit workflow needs this same instance's `reconcileJoinedForkChild` to
  // recover a fork child whose join notify (cross-process, fire-and-forget) was
  // lost or lost the race against a session-exit status write.
  const forkService = createWorkflowForkService({ database: db, getSessionManager: () => sessionManager, boardEvents });

  const workflow = createWorkflowEngine({
    sessionManager,
    boardEvents,
    autoMerge: (...args) => autoMerge(...args),
    reconcileForkChildOnExit: (workspaceId) => forkService.reconcileJoinedForkChild(workspaceId),
  });
  autoMerge = createAutoMerge({ sessionManager, boardEvents, learningSessionIds: workflow.learningSessionIds });
  runWorkflowOnExit = workflow.runWorkflowOnExit;

  return { injectWebSocket, upgradeWebSocket, boardEvents, sessionManager, workflow, forkService, autoMerge };
}
