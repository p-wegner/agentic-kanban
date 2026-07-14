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
import { createMonitorSetup } from "./startup/monitor-setup.js";
import { setupProcessHandlers } from "./startup/process-handlers.js";
import { setupRoutes } from "./startup/route-setup.js";
import { BACKGROUND_SERVICES } from "./startup/background-services.js";
import { runStartupTasks } from "./startup/startup-tasks.js";
import { runSessionRestore } from "./startup/session-restore.js";
import { cleanupExpiredRuntimeState } from "./repositories/runtime-state.repository.js";
import { invalidateAgentQuestionsCache } from "./services/agent-questions.service.js";
import { domainErrorHandler } from "./middleware/error-handler.js";
import { jsonGzip } from "./middleware/compress.js";
import { slowRequestLogger } from "./middleware/slow-request-logger.js";
import { assertNoCommittedConflictMarkers } from "./startup/conflict-marker-scanner.js";
import { checkHealthDeps } from "./services/health-deps.service.js";
import { workspaceServicesService, parseStoredComposeProjectName } from "./services/workspace-services.service.js";
import { workspaces, projects } from "@agentic-kanban/shared/schema";
import { and, isNotNull, ne } from "drizzle-orm";
import { dockerAvailable } from "@agentic-kanban/shared/lib/docker-exec";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverStartRepoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../");

let activeStartupTimerCleanup: (() => void) | null = null;

/**
 * Reap orphaned per-workspace Docker service stacks left by a crash/hard-restart:
 * compose projects THIS instance owns (`ak-<instanceId>-ws-…`, keyed on the id
 * persisted in this DB) that no still-open workspace expects. The Docker daemon is
 * shared by every board instance on the host (worktree dev servers on the
 * ~/.agentic-kanban fallback DB, DooD containers), so the engine filters on the
 * instance-scoped name before downing — other instances' stacks and legacy unscoped
 * `ak-ws-…` names are never touched. Guarded by `dockerAvailable()` so non-docker
 * hosts (the single-user local default) no-op silently. Best-effort — never blocks
 * startup.
 */
async function reapOrphanServiceStacksOnStartup(): Promise<void> {
  try {
    // Cheap DB pre-check BEFORE the (up to 5s) docker probe (#F3a): if NO workspace ever
    // provisioned a stack AND no project even has services enabled, there is nothing to
    // reap — skip the probe entirely so a "docker installed but stopped" host doesn't pay
    // 5s on every boot.
    const openRows = await db
      .select({ serviceState: workspaces.serviceState })
      .from(workspaces)
      .where(and(ne(workspaces.status, "closed"), isNotNull(workspaces.serviceState)));
    let anyProjectStackEnabled = false;
    if (openRows.length === 0) {
      const projectRows = await db
        .select({ servicesConfig: projects.servicesConfig })
        .from(projects)
        .where(isNotNull(projects.servicesConfig));
      anyProjectStackEnabled = projectRows.some((r) => {
        try {
          const parsed = JSON.parse(r.servicesConfig ?? "null") as { enabled?: unknown } | null;
          return parsed?.enabled === true;
        } catch { return false; }
      });
    }
    if (openRows.length === 0 && !anyProjectStackEnabled) return;

    if (!(await dockerAvailable())) return;
    const known = new Set<string>();
    for (const row of openRows) {
      const name = parseStoredComposeProjectName(row.serviceState);
      if (name) known.add(name);
    }
    const { reaped } = await workspaceServicesService.reapOrphanServiceStacks({ knownComposeProjectNames: known });
    if (reaped.length > 0) {
      console.log(`[startup] reaped ${reaped.length} orphan service stack(s): ${reaped.join(", ")}`);
    }
  } catch (err) {
    console.warn("[startup] service-stack reaper failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
}

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

  // Reap orphan service stacks after stale-session cleanup (runs inside runStartupTasks).
  await reapOrphanServiceStacksOnStartup();

  // Fail-fast guard: scan committed source files for conflict markers.
  // Logs a [fatal] alert for every affected file+line.  Non-crashing so the
  // server can still start and the developer can reach the board to fix it.
  try {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
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

  // Start every background service (periodic reconcilers, schedulers, supervisors)
  // from the plugin registry. Each entry's start() returns an optional cleanup that
  // is collected into cleanupCallbacks in registry order, so shutdown (which reverses
  // the list) tears them down last-started-first — identical to the previous inline
  // start-call + cleanup-push list. The append target is background-services.ts, not
  // this composition root (arch-review §1.5). Start errors propagate as before (only
  // the backup scheduler swallows its own preference-read failure, internally).
  const backgroundServiceContext = {
    db,
    boardEvents,
    getSessionManager: () => sessionManager,
    serverPort,
    reviewSessionIds: workflow.reviewSessionIds,
    boardRepoRoot: serverStartRepoRoot,
  };
  for (const service of BACKGROUND_SERVICES) {
    const cleanup = await service.start(backgroundServiceContext);
    if (cleanup) cleanupCallbacks.push(cleanup);
  }

  setupProcessHandlers(server, agentService, { cleanupStartupTimers });

  // Sweep expired runtime_state rows (TTL'd agent-question markers etc., #975) so the
  // dedicated runtime-state table cannot grow without bound. Best-effort, one-shot.
  void cleanupExpiredRuntimeState(new Date().toISOString(), db).catch((err: unknown) => {
    console.warn("[runtime-state] cleanup sweep failed (non-fatal):", err instanceof Error ? err.message : err);
  });

  return { app, sessionManager, boardEvents };
}
