import { readFileSync } from "node:fs";
import { createSecureServer } from "node:http2";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { corsOrigin } from "./lib/cors-origin.js";
import { db } from "./db/index.js";
import * as agentService from "./services/agent.service.js";
import { createBoardEvents } from "./services/board-events.js";
import { createSessionManager } from "./services/session.manager.js";
import { createWorkflowEngine } from "./startup/exit-workflow.js";
import { createAutoMerge } from "./startup/merge-workflow.js";
import { startAutoMergeOrchestrator, stopAutoMergeOrchestrator } from "./startup/auto-merge-orchestrator.js";
import { startStrandedReviewReconciler, stopStrandedReviewReconciler } from "./startup/stranded-review-reconciler.js";
import { startStrandedPlanReconciler, stopStrandedPlanReconciler } from "./startup/plan-mode-reconciler.js";
import { startZombieFixSessionReconciler, stopZombieFixSessionReconciler } from "./startup/zombie-fix-session-reconciler.js";
import { startAncestorBranchReconciler, stopAncestorBranchReconciler } from "./startup/ancestor-branch-reconciler.js";
import { startDoneUnmergedScanner, stopDoneUnmergedScanner } from "./startup/done-unmerged-invariant-scanner.js";
import { startTerminalWorkspaceReaper, stopTerminalWorkspaceReaper } from "./startup/terminal-workspace-reaper.js";
import { createMonitorSetup } from "./startup/monitor-setup.js";
import { setupProcessHandlers } from "./startup/process-handlers.js";
import { setupRoutes } from "./startup/route-setup.js";
import { setupScheduledTasks, stopScheduledTasks } from "./startup/scheduled-tasks.js";
import { startMonitorButler, stopMonitorButler } from "./services/monitor-butler.js";
import { startProjectConductorSupervisor } from "./services/project-conductor.service.js";
import { runStartupTasks } from "./startup/startup-tasks.js";
import { runSessionRestore } from "./startup/session-restore.js";
import { startBackupScheduler, stopBackupScheduler } from "./startup/backup-scheduler.js";
import { startSessionMessagePruner, stopSessionMessagePruner } from "./services/session-message-pruner.service.js";
import { getPreference } from "./repositories/preferences.repository.js";
import { cleanupExpiredRuntimeState } from "./repositories/runtime-state.repository.js";
import { invalidateAgentQuestionsCache } from "./services/agent-questions.service.js";
import { domainErrorHandler } from "./middleware/error-handler.js";
import { jsonGzip } from "./middleware/compress.js";
import { slowRequestLogger } from "./middleware/slow-request-logger.js";
import { assertNoCommittedConflictMarkers } from "./startup/conflict-marker-scanner.js";
import { checkHealthDeps } from "./services/health-deps.service.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverStartRepoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../");

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
  // Reflect only trusted local UI origins, never `*` — the wildcard let any
  // visited website read this unauthenticated local API (confused-deputy). See
  // lib/cors-origin.ts.
  app.use("/api/*", cors({ origin: corsOrigin }));
  app.use("/api/*", slowRequestLogger);
  // Gzip for large buffered JSON GET responses (board ~172KB, issues ~1MB,
  // monitor-status ~60KB) — ~85% wire reduction for remote (Tailscale) access.
  // SSE (text/event-stream) is excluded by content-type inside the middleware;
  // WebSocket upgrades live under /ws/* and never enter this mount.
  app.use("/api/*", jsonGzip);
  // Dependency-aware health probe. A bare "status: ok" stayed green even when
  // the shared package's dist was missing after a restart (#691), so monitors
  // polling /health never noticed that every DB-backed API route was broken
  // with ERR_MODULE_NOT_FOUND. Return 503/"degraded" when a critical dep
  // (notably shared dist) is absent.
  app.get("/health", (c) => {
    const deps = checkHealthDeps(serverStartRepoRoot);
    return c.json(
      { status: deps.ok ? "ok" : "degraded", ok: deps.ok, checks: deps.checks },
      deps.ok ? 200 : 503,
    );
  });
  app.onError(domainErrorHandler);

  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const boardEvents = createBoardEvents();
  boardEvents.startCleanup();
  cleanupCallbacks.push(() => boardEvents.stopCleanup());
  // Keep the agent-questions response cache correct: any board event for a
  // project (session exit, workspace status change, MCP comment notify, ...)
  // drops that project's cached pending-questions listing.
  boardEvents.addInvalidationListener((projectId) => invalidateAgentQuestionsCache(projectId));
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
  const monitorSetup = createMonitorSetup({ sessionManager, boardEvents, serverPort, reviewSessionIds: workflow.reviewSessionIds, fixAndMergeSessionIds: workflow.fixAndMergeSessionIds });
  cleanupCallbacks.push(() => monitorSetup.stop());
  monitorSetup.setupMonitorRoutes(app);

  console.log(`Server starting on port ${serverPort}...`);
  // Optional HTTP/2: set KANBAN_TLS_CERT + KANBAN_TLS_KEY to PEM paths to serve over
  // TLS with HTTP/2. Browsers only negotiate h2 over TLS, and h2 multiplexes every
  // request over ONE connection — lifting the ~6-connection-per-origin HTTP/1.1 cap
  // that throttles request fan-outs like the Settings panel. `allowHTTP1: true` keeps
  // plain HTTP/1.1 clients AND WebSocket upgrades (@hono/node-ws upgrades over 1.1)
  // working. With the env vars unset this is a no-op and the server stays HTTP/1.1.
  // For network access via Tailscale: `tailscale cert <name>.ts.net` issues the PEMs.
  const tlsKeyPath = process.env.KANBAN_TLS_KEY?.trim();
  const tlsCertPath = process.env.KANBAN_TLS_CERT?.trim();
  let tls: { key: Buffer; cert: Buffer } | null = null;
  if (tlsKeyPath && tlsCertPath) {
    try {
      tls = { key: readFileSync(tlsKeyPath), cert: readFileSync(tlsCertPath) };
    } catch (err) {
      console.warn(`[http2] KANBAN_TLS_KEY/CERT set but unreadable — staying on HTTP/1.1: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const onListen = (info: { port: number }) => {
    const scheme = tls ? "https" : "http";
    console.log(`Server running at ${scheme}://${serverHost}:${info.port}${tls ? " (HTTP/2, HTTP/1.1 fallback enabled)" : ""}`);
  };
  const server = tls
    ? serve({ fetch: app.fetch, port: serverPort, hostname: serverHost, createServer: createSecureServer, serverOptions: { key: tls.key, cert: tls.cert, allowHTTP1: true } }, onListen)
    : serve({ fetch: app.fetch, port: serverPort, hostname: serverHost }, onListen);
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
  // Crash-safe recovery for plan-mode workspaces stranded with planMode stuck true (#924):
  // recovers the captured plan (or clears planMode + marks blocked) so the workspace never
  // silently parks idle re-running read-only on every follow-up turn.
  startStrandedPlanReconciler({
    getSessionManager: () => sessionManager,
    boardEvents,
  });
  cleanupCallbacks.push(stopStrandedPlanReconciler);
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
  // Keeps terminal issue workspace rows from inflating WIP/merge-queue counts after
  // git proves the branch has no unmerged ahead work.
  startTerminalWorkspaceReaper();
  cleanupCallbacks.push(stopTerminalWorkspaceReaper);
  // Autonomous Monitor Butler — cron-driven board-health agent (gated by the
  // monitor_butler_enabled preference; off by default). See services/monitor-butler.ts.
  startMonitorButler();
  cleanupCallbacks.push(stopMonitorButler);
  const projectConductorSupervisor = startProjectConductorSupervisor({ database: db, boardRepoRoot: serverStartRepoRoot });
  cleanupCallbacks.push(() => projectConductorSupervisor.stop());
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

  // Sweep expired runtime_state rows (TTL'd agent-question markers etc., #975) so the
  // dedicated runtime-state table cannot grow without bound. Best-effort, one-shot.
  void cleanupExpiredRuntimeState(new Date().toISOString(), db).catch((err: unknown) => {
    console.warn("[runtime-state] cleanup sweep failed (non-fatal):", err instanceof Error ? err.message : err);
  });

  return { app, sessionManager, boardEvents };
}
