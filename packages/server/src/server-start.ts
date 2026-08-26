import { readFileSync } from "node:fs";
import { createSecureServer } from "node:http2";
import { serve } from "@hono/node-server";
import { VERIFY_SCRIPT_TIMEOUT_MS } from "./services/verify-budget.js";
import { resolveBoardServerPort } from "@agentic-kanban/shared/lib/board-server-url";
import * as agentService from "./services/agent.service.js";
import { createMonitorSetup } from "./startup/monitor-setup.js";
import { setupProcessHandlers } from "./startup/process-handlers.js";
import { resolveFleetHost, resolveFleetPort, startFleetListener } from "./services/fleet-listener.service.js";
import { ensureGitHttpServer, stopGitHttpServer } from "./services/git-http.service.js";
import { createFleetWorkersRoute } from "./routes/workers.js";
import { setupRoutes } from "./startup/route-setup.js";
import { BACKGROUND_SERVICES } from "./startup/background-services.js";
import { runGatedDeferredStartupTasks, runStartupAuditTasks } from "./startup/startup-tasks.js";
import { markStartupComplete } from "./startup/readiness.js";
import { cleanupExpiredRuntimeState } from "./repositories/runtime-state.repository.js";
import { ensureLoopLagMonitor, stopLoopLagMonitor } from "./lib/loop-lag-registry.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { db } from "./db/index.js";
import { cleanupStartupTimers, replaceStartupTimerCleanup } from "./startup/startup-timer-registry.js";
import { createBootstrappedApp } from "./startup/app-bootstrap.js";
import { wireCoreServices } from "./startup/core-services-wiring.js";
import { runBootSequence } from "./startup/boot-sequence.js";
import { maybeStartIpv6CompanionListener } from "./startup/ipv6-companion-listener.js";

export { cleanupStartupTimers, replaceStartupTimerCleanup };

const serverStartRepoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../");

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

  const app = createBootstrappedApp(serverStartRepoRoot);

  const { injectWebSocket, upgradeWebSocket, boardEvents, sessionManager, workflow, forkService } = wireCoreServices(app);
  cleanupCallbacks.push(() => boardEvents.stopCleanup());

  await runBootSequence(sessionManager, workflow, agentService);
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

  // #343 — also listen on the IPv6 loopback, so `http://localhost:PORT` stops paying the
  // ~206ms IPv6-fallback tax Windows imposes on every request. See ipv6-companion-listener.ts.
  const ipv6Server = maybeStartIpv6CompanionListener(app, serverHost, serverPort, Boolean(tls), injectWebSocket);
  if (ipv6Server) cleanupCallbacks.push(() => { ipv6Server.close(); });

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
