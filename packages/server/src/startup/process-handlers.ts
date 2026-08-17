import type * as agentService from "../services/agent.service.js";
import { rawClient, rawWriteClient } from "../db/index.js";
import { createBackup } from "../db/backup.js";
import { isTransientNetworkError } from "../lib/transient-errors.js";
import { activeMerges } from "../services/workspace-internals.js";
import { stopMcpHttpBridge } from "../services/mcp-http-bridge.service.js";
import { stopAllPluginViewsAsync } from "../services/plugin.service.js";
import { appendExitRecord, recordProcessStart } from "../lib/exit-record.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/** First ~3 stack lines: enough to place the throw, short enough to keep the log readable. */
function describeError(value: unknown): string {
  if (value instanceof Error) {
    const head = (value.stack ?? "").split("\n").slice(0, 3).join(" | ");
    return head || value.message;
  }
  return String(value);
}

/** Checkpoint the WAL and take a verified shutdown backup, bounded so it can't hang exit. */
async function checkpointAndBackup(): Promise<void> {
  const work = (async () => {
    try {
      // Flush committed WAL into the main db so a later hard-kill can't strand data.
      await rawWriteClient.execute("PRAGMA wal_checkpoint(TRUNCATE)");
      await rawClient.execute("PRAGMA wal_checkpoint(PASSIVE)");
    } catch (e) {
      console.warn("[backup] shutdown WAL checkpoint failed:", e instanceof Error ? e.message : e);
    }
    try {
      await createBackup("shutdown");
    } catch (e) {
      console.warn("[backup] shutdown backup failed:", e instanceof Error ? e.message : e);
    }
  })();
  // Never let backup work block shutdown indefinitely.
  await Promise.race([work, new Promise<void>((r) => setTimeout(r, 5000).unref())]);
}

export async function waitForActiveMergesToSettle(timeoutMs = 60_000): Promise<number> {
  const merges = [...activeMerges.values()];
  if (merges.length === 0) return 0;

  console.warn(`[shutdown] Waiting for ${merges.length} active merge(s) to settle before closing server...`);
  const waitForMerges = Promise.allSettled(merges.map((merge) => merge.promise)).then(() => merges.length);
  return Promise.race([
    waitForMerges,
    new Promise<number>((resolve) => setTimeout(() => resolve(0), timeoutMs).unref()),
  ]);
}

export function setupProcessHandlers(
  server: { close: (cb: () => void) => void; closeIdleConnections?: () => void },
  agentServiceModule: typeof agentService,
  opts: { cleanupStartupTimers?: () => void } = {},
) {
  // #373 — the death that mattered left no evidence at all. The START record has to be written
  // before anything can crash, and it is also what makes a NOTICE-LESS death (OOM, taskkill /F)
  // detectable at the next boot: a start with no matching exit record.
  recordProcessStart();

  // A normal exit still records itself. `process.on("exit")` is a synchronous-only context, which is
  // why `appendExitRecord` is synchronous.
  process.on("exit", (code) => {
    appendExitRecord({ kind: "exit", code });
  });

  process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error("[fatal] Port already in use — exiting:", err.message);
      appendExitRecord({ kind: "uncaught-exception", code: 1, detail: `EADDRINUSE ${err.message}` });
      process.exit(1);
    }
    if (isTransientNetworkError(err)) {
      // Common during tsx hot-reload teardown: warm butler Anthropic HTTPS
      // socket gets killed mid-read, surfacing as `read ECONNRESET` on
      // TCP.onStreamRead. Swallow with a warning so the dev loop survives.
      console.warn(`[warn] Transient network error (ignored): ${err.code ?? "?"} ${err.message}`);
      return;
    }
    // Recorded even though the process survives: a crash the server shrugged off is still the best
    // clue about what a LATER unexplained death was doing beforehand.
    console.error("[error] Uncaught exception (recoverable):", err);
    appendExitRecord({ kind: "uncaught-exception", detail: describeError(err) });
  });

  process.on("unhandledRejection", (reason) => {
    if (isTransientNetworkError(reason)) {
      const code = (reason as NodeJS.ErrnoException).code ?? "?";
      const msg = errorMessage(reason);
      console.warn(`[warn] Transient network rejection (ignored): ${code} ${msg}`);
      return;
    }
    console.error("[error] Unhandled rejection (suppressed):", reason);
    appendExitRecord({ kind: "unhandled-rejection", detail: describeError(reason) });
  });

  async function shutdown(signal: string) {
    // Written FIRST, before any of the bounded-but-slow shutdown work below (merge settling can take
    // 60s, the forced-exit timer 70s). A record written at the end would be lost in exactly the case
    // worth diagnosing — a shutdown that never completed.
    appendExitRecord({ kind: "signal", signal });
    opts.cleanupStartupTimers?.();
    // Agent processes are spawned detached+unref'd — they survive hot-reload without being killed.
    // Only kill them on explicit SIGINT (user Ctrl+C) to avoid orphaning on intentional shutdown.
    const activeCount = signal === "SIGINT" ? agentServiceModule.killAll() : 0;
    // The HTTP MCP listener is a child of THIS process and holds a port, so it must
    // go on any shutdown — not just SIGINT like the detached agents. A survivor
    // would keep the port bound and the next board start would spawn a second one.
    stopMcpHttpBridge();
    // Plugin view servers are non-detached children of THIS process holding ports —
    // like the MCP bridge, they must go on any shutdown (cheap to restart on demand).
    // AWAITED (#352): the tree kill spawns `taskkill /T /F`, and the old fire-and-forget call
    // raced `process.exit(0)` below — so a shutdown could exit before the grandchild
    // `node serve.mjs` was actually killed, leaving exactly the orphan class this fixes. The
    // 70s hard-exit timer above still bounds the whole shutdown.
    const pluginViews = await stopAllPluginViewsAsync();
    if (pluginViews > 0) console.log(`[shutdown] stopped ${pluginViews} plugin view server(s)`);
    console.log(`[shutdown] Received ${signal} — closing server (${activeCount} agent process(es) terminated, survivors continue)...`);
    // Hard cap so shutdown work can never block exit indefinitely.
    setTimeout(() => {
      console.error("[shutdown] Forced exit after 70s timeout");
      process.exit(1);
    }, 70_000).unref();
    await waitForActiveMergesToSettle();
    // Checkpoint + verified backup before closing (non-fatal, bounded to ~5s).
    await checkpointAndBackup();
    // Immediately close idle keep-alive connections so server.close() drains
    // quickly without waiting for the keepAliveTimeout window (Node ≥18.2).
    // closeIdleConnections (not closeAllConnections) preserves in-flight requests
    // so they can finish before the process exits.
    server.closeIdleConnections?.();
    server.close(() => {
      console.log("[shutdown] Server closed.");
      process.exit(0);
    });
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
