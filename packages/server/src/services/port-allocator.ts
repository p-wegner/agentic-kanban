import net from "node:net";

/**
 * Free-port allocator for per-workspace Docker service stacks.
 *
 * Service HOST ports are allocated at CREATE time from actually-free ports (rather
 * than derived deterministically) so that stacks from different projects/workspaces
 * never collide. The deterministic bit is only the COMPOSE_PROJECT_NAME (see
 * `@agentic-kanban/shared/lib/service-ports`); the ports themselves come from here.
 *
 * Node-only (`node:net`).
 */

/** Bind :0 on 127.0.0.1 to find one free TCP port. The server stays open until closed. */
function reservePort(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr == null || typeof addr === "string") {
        server.close();
        reject(new Error("failed to obtain a free port (no address)"));
        return;
      }
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

/**
 * Bind :0 on 127.0.0.1 to find N free TCP ports, returning a name->port map. All
 * reservation sockets are held open until every port has been collected, then closed
 * — so the OS cannot hand the same port out twice within a single call.
 */
export async function allocateFreePorts(names: string[]): Promise<Record<string, number>> {
  const reservations: { port: number; close: () => Promise<void> }[] = [];
  try {
    for (let i = 0; i < names.length; i++) {
      reservations.push(await reservePort());
    }
    const result: Record<string, number> = {};
    for (let i = 0; i < names.length; i++) {
      result[names[i]] = reservations[i].port;
    }
    return result;
  } finally {
    // Release the OS reservations only AFTER collecting every port, so distinct ports
    // are guaranteed within one call. Compose (or whoever) then binds them for real.
    await Promise.all(reservations.map((r) => r.close()));
  }
}
