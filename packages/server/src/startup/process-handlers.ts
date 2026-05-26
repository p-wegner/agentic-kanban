import type * as agentService from "../services/agent.service.js";

export function setupProcessHandlers(server: { close: (cb: () => void) => void }, agentServiceModule: typeof agentService) {
  process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error("[fatal] Port already in use — exiting:", err.message);
      process.exit(1);
    }
    console.error("[error] Uncaught exception (recoverable):", err);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[error] Unhandled rejection (suppressed):", reason);
  });

  function shutdown(signal: string) {
    // Agent processes are spawned detached+unref'd — they survive hot-reload without being killed.
    // Only kill them on explicit SIGINT (user Ctrl+C) to avoid orphaning on intentional shutdown.
    const activeCount = signal === "SIGINT" ? agentServiceModule.killAll() : 0;
    console.log(`[shutdown] Received ${signal} — closing server (${activeCount} agent process(es) terminated, survivors continue)...`);
    server.close(() => {
      console.log("[shutdown] Server closed.");
      process.exit(0);
    });
    setTimeout(() => {
      console.error("[shutdown] Forced exit after 5s timeout");
      process.exit(1);
    }, 5000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
