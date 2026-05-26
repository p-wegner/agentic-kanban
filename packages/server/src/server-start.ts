import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "./db/index.js";
import * as agentService from "./services/agent.service.js";
import { createBoardEvents } from "./services/board-events.js";
import { createSessionManager } from "./services/session.manager.js";
import { createWorkflowEngine } from "./startup/exit-workflow.js";
import { createAutoMerge } from "./startup/merge-workflow.js";
import { createMonitorSetup } from "./startup/monitor-setup.js";
import { setupProcessHandlers } from "./startup/process-handlers.js";
import { setupRoutes } from "./startup/route-setup.js";
import { setupScheduledTasks } from "./startup/scheduled-tasks.js";
import { runStartupTasks } from "./startup/startup-tasks.js";
import { runSessionRestore } from "./startup/session-restore.js";
import { startBackupScheduler } from "./startup/backup-scheduler.js";
import { getPreference } from "./repositories/preferences.repository.js";
import { domainErrorHandler } from "./middleware/error-handler.js";

export async function startServer(port?: number, hostname?: string) {
  const app = new Hono();
  app.use("/api/*", cors());
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.onError(domainErrorHandler);

  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const boardEvents = createBoardEvents(upgradeWebSocket);
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

  const workflow = createWorkflowEngine({ sessionManager, boardEvents, autoMerge: (...args) => autoMerge(...args) });
  autoMerge = createAutoMerge({ sessionManager, boardEvents, learningSessionIds: workflow.learningSessionIds });
  runWorkflowOnExit = workflow.runWorkflowOnExit;

  await runStartupTasks(sessionManager, { agentService });
  await runSessionRestore(workflow);
  setupRoutes(app, { sessionManager, boardEvents, reviewSessionIds: workflow.reviewSessionIds, fixAndMergeSessionIds: workflow.fixAndMergeSessionIds, db });

  const serverPort = port || Number(process.env.PORT) || 3001;
  const serverHost = hostname || process.env.KANBAN_HOST || "127.0.0.1";
  const { setupMonitorRoutes } = createMonitorSetup({ sessionManager, boardEvents, serverPort });
  setupMonitorRoutes(app);

  console.log(`Server starting on port ${serverPort}...`);
  const server = serve({ fetch: app.fetch, port: serverPort, hostname: serverHost }, (info) => {
    console.log(`Server running at http://${serverHost}:${info.port}`);
  });
  injectWebSocket(server);

  setupScheduledTasks(serverPort);
  setupProcessHandlers(server, agentService);

  // Periodic database backups (interval from the backup_interval_min preference).
  try {
    const raw = await getPreference("backup_interval_min");
    const intervalMin = raw == null || raw === "" ? 30 : Number(raw);
    startBackupScheduler(Number.isFinite(intervalMin) ? intervalMin : 30);
  } catch (err) {
    console.warn("[backup] failed to start scheduler (non-fatal):", err instanceof Error ? err.message : err);
  }

  return { app, sessionManager, boardEvents };
}
