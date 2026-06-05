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
import { startAutoMergeOrchestrator } from "./startup/auto-merge-orchestrator.js";
import { startStrandedReviewReconciler } from "./startup/stranded-review-reconciler.js";
import { startAncestorBranchReconciler } from "./startup/ancestor-branch-reconciler.js";
import { startDoneUnmergedScanner } from "./startup/done-unmerged-invariant-scanner.js";
import { createMonitorSetup } from "./startup/monitor-setup.js";
import { setupProcessHandlers } from "./startup/process-handlers.js";
import { setupRoutes } from "./startup/route-setup.js";
import { setupScheduledTasks } from "./startup/scheduled-tasks.js";
import { startMonitorButler } from "./services/monitor-butler.js";
import { runStartupTasks } from "./startup/startup-tasks.js";
import { runSessionRestore } from "./startup/session-restore.js";
import { startBackupScheduler } from "./startup/backup-scheduler.js";
import { startSessionMessagePruner } from "./services/session-message-pruner.service.js";
import { getPreference } from "./repositories/preferences.repository.js";
import { domainErrorHandler } from "./middleware/error-handler.js";
import { slowRequestLogger } from "./middleware/slow-request-logger.js";

export async function startServer(port?: number, hostname?: string) {
  const app = new Hono();
  app.use("/api/*", cors());
  app.use("/api/*", slowRequestLogger);
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.onError(domainErrorHandler);

  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const boardEvents = createBoardEvents();
  boardEvents.startCleanup();
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
  setupRoutes(app, { sessionManager, boardEvents, reviewSessionIds: workflow.reviewSessionIds, fixAndMergeSessionIds: workflow.fixAndMergeSessionIds, db, upgradeWebSocket });

  const serverPort = port || Number(process.env.PORT) || 3001;
  const serverHost = hostname || process.env.KANBAN_HOST || "127.0.0.1";
  const { setupMonitorRoutes } = createMonitorSetup({ sessionManager, boardEvents, serverPort });
  setupMonitorRoutes(app);

  console.log(`Server starting on port ${serverPort}...`);
  const server = serve({ fetch: app.fetch, port: serverPort, hostname: serverHost }, (info) => {
    console.log(`Server running at http://${serverHost}:${info.port}`);
  });
  // Short keep-alive timeout so idle persistent connections close promptly when
  // tsx-watch restarts the server after a merge lands new TypeScript files.
  // The Node default is 5 s — long enough for a second request to arrive on the
  // same socket right as the process is shutting down, producing ECONNRESET.
  // 1 s is short enough to clear idle connections quickly while still amortising
  // the TCP handshake cost across rapid back-to-back requests.
  (server as { keepAliveTimeout?: number }).keepAliveTimeout = 1000;
  injectWebSocket(server);

  setupScheduledTasks(serverPort);
  startAutoMergeOrchestrator({
    database: db,
    boardEvents,
    getSessionManager: () => sessionManager,
  });
  // Crash-safe recovery for work stranded in "In Review" because the auto-review
  // handshake never fired (#529): re-launches the review so the chain can complete.
  startStrandedReviewReconciler({
    getSessionManager: () => sessionManager,
    boardEvents,
    reviewSessionIds: workflow.reviewSessionIds,
  });
  startAncestorBranchReconciler();
  // Log-only: detect Done-but-unmerged silent-merge-loss and emit board health
  // events, but do NOT auto-reopen. Auto-reopen flips ancient stale branches
  // (observed 60-658 commits behind base) back to In Review, polluting the board
  // and luring the merge chain into dangerous stale-merges; it also false-positives
  // on issues already merged via a different workspace. Detection stays; mutation off.
  startDoneUnmergedScanner({ reopenToInReview: false });
  // Autonomous Monitor Butler — cron-driven board-health agent (gated by the
  // monitor_butler_enabled preference; off by default). See services/monitor-butler.ts.
  startMonitorButler();
  setupProcessHandlers(server, agentService);

  // Periodic database backups (interval from the backup_interval_min preference).
  try {
    const raw = await getPreference("backup_interval_min");
    const intervalMin = raw == null || raw === "" ? 30 : Number(raw);
    startBackupScheduler(Number.isFinite(intervalMin) ? intervalMin : 30);
  } catch (err) {
    console.warn("[backup] failed to start scheduler (non-fatal):", err instanceof Error ? err.message : err);
  }

  // Periodic session_messages pruning — keeps DB size bounded as workspace history grows.
  startSessionMessagePruner(db);

  return { app, sessionManager, boardEvents };
}
