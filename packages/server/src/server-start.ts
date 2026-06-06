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
import { startAutoMergeOrchestrator, stopAutoMergeOrchestrator } from "./startup/auto-merge-orchestrator.js";
import { startStrandedReviewReconciler, stopStrandedReviewReconciler } from "./startup/stranded-review-reconciler.js";
import { startZombieFixSessionReconciler, stopZombieFixSessionReconciler } from "./startup/zombie-fix-session-reconciler.js";
import { startAncestorBranchReconciler, stopAncestorBranchReconciler } from "./startup/ancestor-branch-reconciler.js";
import { startDoneUnmergedScanner, stopDoneUnmergedScanner } from "./startup/done-unmerged-invariant-scanner.js";
import { createMonitorSetup } from "./startup/monitor-setup.js";
import { setupProcessHandlers } from "./startup/process-handlers.js";
import { setupRoutes } from "./startup/route-setup.js";
import { setupScheduledTasks, stopScheduledTasks } from "./startup/scheduled-tasks.js";
import { startMonitorButler, stopMonitorButler } from "./services/monitor-butler.js";
import { runStartupTasks } from "./startup/startup-tasks.js";
import { runSessionRestore } from "./startup/session-restore.js";
import { startBackupScheduler, stopBackupScheduler } from "./startup/backup-scheduler.js";
import { startSessionMessagePruner, stopSessionMessagePruner } from "./services/session-message-pruner.service.js";
import { getPreference } from "./repositories/preferences.repository.js";
import { domainErrorHandler } from "./middleware/error-handler.js";
import { slowRequestLogger } from "./middleware/slow-request-logger.js";
import { assertNoCommittedConflictMarkers } from "./startup/conflict-marker-scanner.js";

let activeStartupTimerCleanup: (() => void) | null = null;

export function cleanupStartupTimers(): void {
  if (!activeStartupTimerCleanup) return;
  const cleanup = activeStartupTimerCleanup;
  activeStartupTimerCleanup = null;
  cleanup();
}

export function replaceStartupTimerCleanup(cleanupCallbacks: Array<() => void>): void {
  cleanupStartupTimers();
  activeStartupTimerCleanup = () => {
    for (const cleanup of cleanupCallbacks.splice(0).reverse()) {
      cleanup();
    }
  };
}

export async function startServer(port?: number, hostname?: string) {
  const cleanupCallbacks: Array<() => void> = [];
  replaceStartupTimerCleanup(cleanupCallbacks);

  const app = new Hono();
  app.use("/api/*", cors());
  app.use("/api/*", slowRequestLogger);
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.onError(domainErrorHandler);

  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const boardEvents = createBoardEvents();
  boardEvents.startCleanup();
  cleanupCallbacks.push(() => boardEvents.stopCleanup());
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

  // Fail-fast guard: scan committed source files for conflict markers.
  // Logs a [fatal] alert for every affected file+line.  Non-crashing so the
  // server can still start and the developer can reach the board to fix it.
  try {
    const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1").replace(/\//g, "\\");
    assertNoCommittedConflictMarkers(repoRoot);
  } catch (err) {
    console.warn("[conflict-marker-scanner] scan failed (non-fatal):", err instanceof Error ? err.message : err);
  }

  await runSessionRestore(workflow);
  setupRoutes(app, { sessionManager, boardEvents, reviewSessionIds: workflow.reviewSessionIds, fixAndMergeSessionIds: workflow.fixAndMergeSessionIds, db, upgradeWebSocket });

  const serverPort = port || Number(process.env.PORT) || 3001;
  const serverHost = hostname || process.env.KANBAN_HOST || "127.0.0.1";
  const monitorSetup = createMonitorSetup({ sessionManager, boardEvents, serverPort, reviewSessionIds: workflow.reviewSessionIds });
  cleanupCallbacks.push(() => monitorSetup.stop());
  monitorSetup.setupMonitorRoutes(app);

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
  cleanupCallbacks.push(stopScheduledTasks);
  startAutoMergeOrchestrator({
    database: db,
    boardEvents,
    getSessionManager: () => sessionManager,
  });
  cleanupCallbacks.push(stopAutoMergeOrchestrator);
  // Crash-safe recovery for work stranded in "In Review" because the auto-review
  // handshake never fired (#529): re-launches the review so the chain can complete.
  startStrandedReviewReconciler({
    getSessionManager: () => sessionManager,
    boardEvents,
    reviewSessionIds: workflow.reviewSessionIds,
  });
  cleanupCallbacks.push(stopStrandedReviewReconciler);
  // Crash-safe recovery for zombie fix-and-merge/review sessions: sessions that are
  // marked 'running' but have zero output messages and no live process (#596).
  startZombieFixSessionReconciler({ boardEvents });
  cleanupCallbacks.push(stopZombieFixSessionReconciler);
  startAncestorBranchReconciler();
  cleanupCallbacks.push(stopAncestorBranchReconciler);
  // Safe forward-only auto-recovery: merges clean ahead-only Done-but-unmerged branches
  // directly into base (forward-merging can't lose work). Conflicted / too-far-behind /
  // 0-ahead candidates remain log-only. Never reopens an issue.
  startDoneUnmergedScanner();
  cleanupCallbacks.push(stopDoneUnmergedScanner);
  // Autonomous Monitor Butler — cron-driven board-health agent (gated by the
  // monitor_butler_enabled preference; off by default). See services/monitor-butler.ts.
  startMonitorButler();
  cleanupCallbacks.push(stopMonitorButler);
  setupProcessHandlers(server, agentService, { cleanupStartupTimers });

  // Periodic database backups (interval from the backup_interval_min preference).
  try {
    const raw = await getPreference("backup_interval_min");
    const intervalMin = raw == null || raw === "" ? 30 : Number(raw);
    startBackupScheduler(Number.isFinite(intervalMin) ? intervalMin : 30);
    cleanupCallbacks.push(stopBackupScheduler);
  } catch (err) {
    console.warn("[backup] failed to start scheduler (non-fatal):", err instanceof Error ? err.message : err);
  }

  // Periodic session_messages pruning — keeps DB size bounded as workspace history grows.
  startSessionMessagePruner(db);
  cleanupCallbacks.push(stopSessionMessagePruner);

  return { app, sessionManager, boardEvents };
}
