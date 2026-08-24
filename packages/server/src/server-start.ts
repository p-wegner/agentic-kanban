import { readFileSync } from "node:fs";
import { createSecureServer } from "node:http2";
import { serve } from "@hono/node-server";
import { VERIFY_SCRIPT_TIMEOUT_MS } from "./services/verify-budget.js";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { corsOrigin } from "./lib/cors-origin.js";
import { runWithGitPriority } from "@agentic-kanban/shared/lib/git-exec";
import { resolveBoardServerPort } from "@agentic-kanban/shared/lib/board-server-url";
import { db } from "./db/index.js";
import * as agentService from "./services/agent.service.js";
import { createBoardEvents } from "./services/board-events.js";
import { createSessionManager } from "./services/session.manager.js";
import { createWorkflowEngine } from "./startup/exit-workflow.js";
import { createWorkflowForkService } from "./services/workflow-fork.service.js";
import { createAutoMerge } from "./startup/merge-workflow.js";
import { createMonitorSetup } from "./startup/monitor-setup.js";
import { setupProcessHandlers } from "./startup/process-handlers.js";
import { resolveFleetHost, resolveFleetPort, startFleetListener } from "./services/fleet-listener.service.js";
import { ensureGitHttpServer, stopGitHttpServer } from "./services/git-http.service.js";
import { createFleetWorkersRoute } from "./routes/workers.js";
import { setupRoutes } from "./startup/route-setup.js";
import { BACKGROUND_SERVICES } from "./startup/background-services.js";
import { runCriticalStartupTasks, runGatedDeferredStartupTasks, runStartupAuditTasks } from "./startup/startup-tasks.js";
import { createStartupReadinessGate, markStartupComplete } from "./startup/readiness.js";
import { runSessionRestore } from "./startup/session-restore.js";
import { cleanupExpiredRuntimeState } from "./repositories/runtime-state.repository.js";
import { invalidateAgentQuestionsCache } from "./services/agent-questions.service.js";
import { domainErrorHandler } from "./middleware/error-handler.js";
import { jsonGzip } from "./middleware/compress.js";
import { slowRequestLogger } from "./middleware/slow-request-logger.js";
import { ensureLoopLagMonitor, stopLoopLagMonitor } from "./lib/loop-lag-registry.js";
import { assertNoCommittedConflictMarkers } from "./startup/conflict-marker-scanner.js";
import { checkHealthDeps } from "./services/health-deps.service.js";
import { reapOrphanServiceStacksOnce } from "./startup/service-stack-reaper.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { attachButlerEventFeed } from "./services/butler-event-feed.js";
import { getButlerSession, sendButlerTurn } from "./services/butler-sdk.service.js";
import { getPreference } from "./repositories/preferences.repository.js";

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

  // Start sampling event-loop delay before anything else runs (#347). The board's
  // dominant slowness is loop BLOCKING — /api/health, pure JS with no I/O, measured
  // 3.6-30s while CPU sat at 25% — and until now it was unattributable at runtime:
  // the slow-request log conflates "this handler was slow" with "this handler sat behind
  // someone else's block". Exposed on GET /api/metrics/loop-lag; a window whose max lag
  // crosses the threshold logs a timestamped `[loop-lag]` warning that can be lined up
  // against the slow-request ring buffer and the monitor's per-phase timings.
  // Idempotent, so a tsx hot-reload does not stack histograms or timers.
  ensureLoopLagMonitor();
  cleanupCallbacks.push(() => { stopLoopLagMonitor(); });

  const app = new Hono();
  // Reflect only trusted local UI origins, never `*` — the wildcard let any
  // visited website read this unauthenticated local API (confused-deputy). See
  // lib/cors-origin.ts.
  app.use("/api/*", cors({ origin: corsOrigin }));
  app.use("/api/*", slowRequestLogger);
  app.use("/api/*", (_c, next) => runWithGitPriority("interactive", next)); // #398 G8 — request-path git jumps the spawn queue's normal lane
  // Gzip for large buffered JSON GET responses (board ~172KB, issues ~1MB,
  // monitor-status ~60KB) — ~85% wire reduction for remote (Tailscale) access.
  // SSE (text/event-stream) is excluded by content-type inside the middleware;
  // WebSocket upgrades live under /ws/* and never enter this mount.
  app.use("/api/*", jsonGzip);
  // #282 — the deferred startup phase runs BEHIND the listener, so reads answer
  // immediately while writes still see the state the reconcilers repair. Mounted before
  // the routes so it covers every /api mutation, including the monitor routes below.
  app.use("/api/*", createStartupReadinessGate());
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

  // #282 — only the work that must precede serving: process cleanup, migrations, FK
  // assertions, session settling. Every git-spawning reconciler moved to the deferred
  // phase started after `serve()` below.
  await runCriticalStartupTasks(sessionManager, { agentService });

  // Reap orphan service stacks after stale-session cleanup (runs inside the critical phase).
  // Boot pass runs BEFORE setupRoutes so no HTTP create can race it — and it does NOT
  // shield mid-provision null-state rows (a crash-mid-`up` leaves no state; that IS the
  // orphan to reclaim). The periodic pass (background-services) shields those instead,
  // since it runs concurrently with live creates. Both share this one engine (#52).
  await reapOrphanServiceStacksOnce({ shieldMidProvision: false, logLabel: "startup" });

  // Boot preflight (#55): fail LOUDLY on the silent DooD misconfigs (undialable
  // KANBAN_SERVICE_HOST, a daemon that can't see the data root). No-op unless a project
  // declares an enabled stack AND docker is available; never blocks startup.
  try {
    const { runServiceStackPreflight } = await import("./startup/service-stack-preflight.js");
    const { anyProjectHasEnabledServiceStack } = await import("./repositories/workspace-service-state.repository.js");
    const { DATA_DIR } = await import("./db/data-dir.js");
    await runServiceStackPreflight({ dataRoot: DATA_DIR, hasEnabledStack: anyProjectHasEnabledServiceStack });
  } catch (err) {
    console.warn("[services-preflight] preflight bootstrap failed (non-fatal):", err instanceof Error ? err.message : err);
  }

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
  setupRoutes(app, { sessionManager, boardEvents, reviewSessionIds: workflow.reviewSessionIds, fixAndMergeSessionIds: workflow.fixAndMergeSessionIds, db, upgradeWebSocket, forkService });

  const serverPort = port || resolveBoardServerPort();
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
      console.warn(`[http2] KANBAN_TLS_KEY/CERT set but unreadable — staying on HTTP/1.1: ${errorMessage(err)}`);
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
  // Node's DEFAULT `requestTimeout` is 5 minutes; the board budgets a verify run 45 (#680).
  //
  // Defensive, and deliberately NOT dressed up as a measurement: the `HTTP 000` merge drops that
  // prompted this were traced to `tsx watch` restarting the dev server mid-request (an edit to a
  // server file during the run), not to this ceiling — they died at ~13-16 minutes, not at 5. So
  // whether Node's default ever actually cut a merge here is UNVERIFIED. What is not in doubt is
  // that a 5-minute transport ceiling under a 45-minute operation is a mismatch waiting to
  // happen, on merge, review, fix-and-merge, or a cold-clone base probe.
  //
  // Not 0 (disabled): a genuinely stuck request should still be reaped eventually. The budget is
  // the verify budget plus slack for the install/clone/smoke phases that surround it, so the
  // ceiling stays above the longest thing the server legitimately does — the same rule as every
  // other budget in this repo, and the same failure mode when it is not.
  const HTTP_REQUEST_TIMEOUT_MS = VERIFY_SCRIPT_TIMEOUT_MS + 15 * 60 * 1000;
  (server as { requestTimeout?: number }).requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  // `headersTimeout` must not sit below `requestTimeout` or it becomes the effective ceiling.
  (server as { headersTimeout?: number }).headersTimeout = HTTP_REQUEST_TIMEOUT_MS;
  injectWebSocket(server);

  // #343 — also listen on the IPv6 loopback, so `http://localhost:PORT` stops paying a
  // flat ~206ms tax on every single request.
  //
  // Measured on this box: time_connect via `localhost` is 0.204-0.216s, via `127.0.0.1`
  // it is 0.0009s. Windows resolves `localhost` to `::1` FIRST; with only 127.0.0.1 bound,
  // every client attempts the IPv6 connect, waits for it to fail, and falls back to IPv4.
  // That is a hard floor under `time_total`, not server time.
  //
  // It matters because essentially everything the board GENERATES tells agents to use
  // `localhost:3001` — worktree ticket-context files, CLAUDE.md, the board-navigator
  // skill, MCP notifyBoard, the docs — so every agent curl and every board-notify pays it,
  // often many times per task.
  //
  // Deliberately `::1` and NOT `::`: the board API has no auth, so the loopback-only
  // posture is a security invariant (see the fleet-port note in CLAUDE.md). `::1` is
  // loopback, so the posture is unchanged. Only added when the primary listener is itself
  // the IPv4 loopback default — an operator who set KANBAN_HOST to something else has
  // chosen their own binding and we must not widen it. Failure to bind is NON-FATAL: the
  // IPv4 listener is the one of record and the fallback path still works, just slowly.
  let ipv6Server: { close: (cb?: () => void) => void } | null = null;
  if (!tls && (serverHost === "127.0.0.1" || serverHost === "localhost")) {
    try {
      const companion = serve({ fetch: app.fetch, port: serverPort, hostname: "::1" }, () => {
        console.log(`Server also running at http://[::1]:${serverPort} (removes the ~206ms IPv6-fallback tax on \`localhost\`)`);
      });
      (companion as { keepAliveTimeout?: number }).keepAliveTimeout = 1000;
      // Same fetch handler, so WS upgrades must work on this listener too — a browser
      // resolving `localhost` to ::1 would otherwise get a dead board socket.
      injectWebSocket(companion);
      companion.on("error", (err: Error) => {
        console.warn(`[ipv6] loopback listener error (non-fatal, IPv4 still serving): ${err.message}`);
      });
      ipv6Server = companion;
    } catch (err) {
      console.warn(`[ipv6] could not bind [::1]:${serverPort} (non-fatal, IPv4 still serving): ${errorMessage(err)}`);
    }
  }
  if (ipv6Server) cleanupCallbacks.push(() => { ipv6Server?.close(); });

  // #282 — the deferrable half of startup now runs BEHIND the bound listener instead of
  // in front of it. Reads (the board payload) are served from this moment; mutating /api
  // requests are held by the readiness gate until this settles, preserving the ordering
  // the serial prologue used to guarantee. Never awaited here: awaiting it would restore
  // exactly the 238 s time-to-first-response this change removes. A failure marks
  // readiness anyway — a broken reconciler must not leave the board permanently unwritable.
  void runGatedDeferredStartupTasks()
    .catch((err) => console.warn("[startup] gated deferred startup phase failed (non-fatal):", err instanceof Error ? err.message : err))
    .finally(() => {
      markStartupComplete();
      console.log("[startup] deferred startup phase complete — mutating requests no longer gated");
    })
    // The audit tail converges state rather than gating it, and on a checkout with many
    // worktrees it runs for tens of minutes. Nothing waits on it.
    .then(() => runStartupAuditTasks())
    .catch((err) => console.warn("[startup] startup audit tasks failed (non-fatal):", err instanceof Error ? err.message : err));

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

  // Fleet listener (epic #184): the ONLY surface exposed off-loopback, and only
  // when KANBAN_FLEET_PORT says so. It serves the worker-called endpoints, each
  // of which authenticates for itself; the main app above stays on 127.0.0.1 so
  // the unauthenticated board API is unreachable from the network by
  // construction rather than by convention. A failure here is non-fatal — the
  // board keeps running locally, just without remote workers.
  const fleetPort = resolveFleetPort();
  if (fleetPort !== null) {
    try {
      const fleetListener = await startFleetListener({
        database: db,
        port: fleetPort,
        createWorkersRoute: createFleetWorkersRoute,
        host: resolveFleetHost(),
      });
      cleanupCallbacks.push(() => { void fleetListener.close(); });
    } catch (err) {
      console.error(
        `[fleet-listener] failed to bind KANBAN_FLEET_PORT=${fleetPort}; remote workers cannot connect:`,
        errorMessage(err),
      );
    }

    // #855 — bind the git transport EAGERLY when a fleet is configured. It used to bind
    // lazily on the first git-transport dispatch only (`ensureGitHttpServer` in
    // agent-remote.service.ts), so from every board restart until that first dispatch a
    // worker probing the pinned KANBAN_GIT_HTTP_PORT saw ECONNREFUSED with no way to tell
    // a healthy pre-dispatch board from a misconfigured one (#847). With KANBAN_FLEET_PORT
    // set the git port is pinned by construction — `gitPortStabilityViolation` refuses an
    // OS-assigned port while a fleet listener exists — so binding at startup exposes
    // nothing new and turns "refused" back into a real signal. Without a fleet port the
    // lazy path stays: a single-user local board must not open a listener it never uses.
    // Failure is NON-FATAL: log and degrade to the lazy path — the dispatch-time
    // `ensureGitHttpServer` call sites remain (the failed memoized promise is reset, so
    // they retry; once this succeeds they are no-ops against the memoized handle).
    try {
      const git = await ensureGitHttpServer(db);
      console.log(`[git-http] bound eagerly at startup for the fleet (port ${git.port})`);
    } catch (err) {
      console.warn(
        "[git-http] eager startup bind failed — degrading to lazy bind on the first git-transport dispatch:",
        errorMessage(err),
      );
    }
  }

  // #856 — release the git transport listener (bound eagerly above on a fleet-configured
  // board, or lazily by a git-transport dispatch) whenever THIS server instance is torn
  // down without the process dying: a fresh startServer() runs the previous instance's
  // cleanup via replaceStartupTimerCleanup, and the signal handlers run it too. Registered
  // unconditionally — stopGitHttpServer is an idempotent no-op when nothing ever bound.
  cleanupCallbacks.push(() => { void stopGitHttpServer(); });

  setupProcessHandlers(server, agentService, { cleanupStartupTimers });

  // Sweep expired runtime_state rows (TTL'd agent-question markers etc., #975) so the
  // dedicated runtime-state table cannot grow without bound. Best-effort, one-shot.
  void cleanupExpiredRuntimeState(new Date().toISOString(), db).catch((err: unknown) => {
    console.warn("[runtime-state] cleanup sweep failed (non-fatal):", err instanceof Error ? err.message : err);
  });

  return { app, sessionManager, boardEvents };
}
