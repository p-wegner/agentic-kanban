import type * as agentService from "../services/agent.service.js";
import { rawClient } from "../db/index.js";
import { createBackup } from "../db/backup.js";
import { isTransientNetworkError } from "./transient-errors.js";
import { activeMerges } from "../services/workspace-internals.js";

/** Checkpoint the WAL and take a verified shutdown backup, bounded so it can't hang exit. */
async function checkpointAndBackup(): Promise<void> {
  const work = (async () => {
    try {
      // Flush committed WAL into the main db so a later hard-kill can't strand data.
      await rawClient.execute("PRAGMA wal_checkpoint(TRUNCATE)");
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

export function setupProcessHandlers(server: { close: (cb: () => void) => void }, agentServiceModule: typeof agentService) {
  process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error("[fatal] Port already in use — exiting:", err.message);
      process.exit(1);
    }
    if (isTransientNetworkError(err)) {
      // Common during tsx hot-reload teardown: warm butler Anthropic HTTPS
      // socket gets killed mid-read, surfacing as `read ECONNRESET` on
      // TCP.onStreamRead. Swallow with a warning so the dev loop survives.
      console.warn(`[warn] Transient network error (ignored): ${err.code ?? "?"} ${err.message}`);
      return;
    }
    console.error("[error] Uncaught exception (recoverable):", err);
  });

  process.on("unhandledRejection", (reason) => {
    if (isTransientNetworkError(reason)) {
      const code = (reason as NodeJS.ErrnoException).code ?? "?";
      const msg = reason instanceof Error ? reason.message : String(reason);
      console.warn(`[warn] Transient network rejection (ignored): ${code} ${msg}`);
      return;
    }
    console.error("[error] Unhandled rejection (suppressed):", reason);
  });

  async function shutdown(signal: string) {
    // Agent processes are spawned detached+unref'd — they survive hot-reload without being killed.
    // Only kill them on explicit SIGINT (user Ctrl+C) to avoid orphaning on intentional shutdown.
    const activeCount = signal === "SIGINT" ? agentServiceModule.killAll() : 0;
    console.log(`[shutdown] Received ${signal} — closing server (${activeCount} agent process(es) terminated, survivors continue)...`);
    // Hard cap so shutdown work can never block exit indefinitely.
    setTimeout(() => {
      console.error("[shutdown] Forced exit after 70s timeout");
      process.exit(1);
    }, 70_000).unref();
    await waitForActiveMergesToSettle();
    // Checkpoint + verified backup before closing (non-fatal, bounded to ~5s).
    await checkpointAndBackup();
    server.close(() => {
      console.log("[shutdown] Server closed.");
      process.exit(0);
    });
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
