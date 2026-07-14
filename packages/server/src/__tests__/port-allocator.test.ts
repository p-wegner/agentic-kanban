import { describe, it, expect } from "vitest";
import net from "node:net";
import { allocateFreePorts } from "../services/port-allocator.js";

/** Assert a port is actually bindable (i.e. was released after allocation). */
function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.on("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

describe("allocateFreePorts", () => {
  it("returns a port for each requested name", async () => {
    const ports = await allocateFreePorts(["db", "cache", "queue"]);
    expect(Object.keys(ports).sort()).toEqual(["cache", "db", "queue"]);
    for (const p of Object.values(ports)) {
      expect(Number.isInteger(p)).toBe(true);
      expect(p).toBeGreaterThan(0);
    }
  });

  it("hands out DISTINCT ports within a single call", async () => {
    const ports = await allocateFreePorts(["a", "b", "c", "d", "e"]);
    const values = Object.values(ports);
    expect(new Set(values).size).toBe(values.length);
  });

  it("returns an empty map for no names", async () => {
    expect(await allocateFreePorts([])).toEqual({});
  });

  it("releases the ports after allocation (they become bindable)", async () => {
    const ports = await allocateFreePorts(["one"]);
    expect(await canBind(ports.one)).toBe(true);
  });
});
