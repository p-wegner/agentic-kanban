import { Hono } from "hono";
import { cors } from "hono/cors";
import { corsOrigin } from "../lib/cors-origin.js";
import { runWithGitPriority } from "@agentic-kanban/shared/lib/git-exec";
import { domainErrorHandler } from "../middleware/error-handler.js";
import { jsonGzip } from "../middleware/compress.js";
import { slowRequestLogger } from "../middleware/slow-request-logger.js";
import { createStartupReadinessGate } from "./readiness.js";
import { checkHealthDeps } from "../services/health-deps.service.js";

/**
 * Builds the Hono app with its `/api/*` middleware chain and `/health` route,
 * extracted from `server-start.ts` (#873). Route mounting for `/api/*` itself
 * happens later via `setupRoutes` — this only wires the cross-cutting
 * middleware every request goes through and the two routes that predate it
 * (health check, error handler).
 */
export function createBootstrappedApp(repoRoot: string): Hono {
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
    const deps = checkHealthDeps(repoRoot);
    return c.json(
      { status: deps.ok ? "ok" : "degraded", ok: deps.ok, checks: deps.checks },
      deps.ok ? 200 : 503,
    );
  });
  app.onError(domainErrorHandler);
  return app;
}
