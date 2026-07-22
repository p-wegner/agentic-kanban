import { describe, it, expect } from "vitest";
import net from "node:net";
import {
  allocateFreePorts,
  createStackPortAllocator,
  releaseStackPorts,
  resolveStackPortRange,
} from "../services/port-allocator.js";

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

describe("resolveStackPortRange", () => {
  it("parses a valid <start>-<end> range", () => {
    expect(resolveStackPortRange({ KANBAN_STACK_PORT_RANGE: "31000-31099" })).toEqual({ start: 31000, end: 31099 });
    expect(resolveStackPortRange({ KANBAN_STACK_PORT_RANGE: " 4000 - 4001 " })).toEqual({ start: 4000, end: 4001 });
  });

  it("returns null when unset", () => {
    expect(resolveStackPortRange({})).toBeNull();
  });

  it("degrades to null (not a throw) on a malformed or out-of-bounds value", () => {
    expect(resolveStackPortRange({ KANBAN_STACK_PORT_RANGE: "not-a-range" })).toBeNull();
    expect(resolveStackPortRange({ KANBAN_STACK_PORT_RANGE: "31099-31000" })).toBeNull(); // start > end
    expect(resolveStackPortRange({ KANBAN_STACK_PORT_RANGE: "0-10" })).toBeNull(); // start < 1
    expect(resolveStackPortRange({ KANBAN_STACK_PORT_RANGE: "60000-99999" })).toBeNull(); // end > 65535
  });
});

describe("createStackPortAllocator — ranged mode (#51/#54)", () => {
  it("draws distinct ports from the configured range, lowest-first, without probing the kernel", async () => {
    const range = { start: 41000, end: 41099 };
    const allocate = createStackPortAllocator({ range });
    try {
      const ports = await allocate(["db", "web"]);
      expect(ports).toEqual({ db: 41000, web: 41001 });
    } finally {
      releaseStackPorts([41000, 41001]);
    }
  });

  it("excludes ports already held by live stacks (from the DB)", async () => {
    const range = { start: 41200, end: 41299 };
    const allocate = createStackPortAllocator({ range, getInUsePorts: async () => [41200, 41201] });
    try {
      const ports = await allocate(["db"]);
      expect(ports.db).toBe(41202);
    } finally {
      releaseStackPorts([41202]);
    }
  });

  it("reserves across calls — a concurrent allocation never overlaps until released (#51 flaw 2)", async () => {
    const range = { start: 41300, end: 41399 };
    const allocate = createStackPortAllocator({ range });
    try {
      const first = await allocate(["a", "b"]);
      const second = await allocate(["c", "d"]); // no release between → must be disjoint
      const all = [...Object.values(first), ...Object.values(second)];
      expect(new Set(all).size).toBe(all.length);
      expect(Object.values(second).every((p) => !Object.values(first).includes(p))).toBe(true);
    } finally {
      releaseStackPorts([41300, 41301, 41302, 41303]);
    }
  });

  it("releaseStackPorts frees a port for reuse by the next allocation", async () => {
    const range = { start: 41400, end: 41400 }; // a range of exactly one port
    const allocate = createStackPortAllocator({ range });
    const first = await allocate(["only"]);
    expect(first.only).toBe(41400);
    releaseStackPorts([41400]);
    const second = await allocate(["again"]); // the single port is free again
    expect(second.again).toBe(41400);
    releaseStackPorts([41400]);
  });

  it("throws when the range is exhausted, and leaks no partial reservation", async () => {
    const range = { start: 41500, end: 41501 }; // two ports
    const allocate = createStackPortAllocator({ range });
    await expect(allocate(["a", "b", "c"])).rejects.toThrow(/no free stack host port/i);
    // The two it managed to take before failing must have been rolled back, so a fresh
    // two-port request now succeeds against the same full range.
    const ok = await allocate(["x", "y"]);
    expect(Object.values(ok).sort()).toEqual([41500, 41501]);
    releaseStackPorts([41500, 41501]);
  });

  it("skips a candidate that fails the bind probe when probe is enabled", async () => {
    const range = { start: 41600, end: 41699 };
    // Occupy 41600 for real, so a probing allocator must move to 41601.
    const blocker = net.createServer();
    await new Promise<void>((res) => blocker.listen(41600, "127.0.0.1", () => res()));
    const allocate = createStackPortAllocator({ range, probe: true });
    try {
      const ports = await allocate(["db"]);
      expect(ports.db).toBe(41601);
    } finally {
      releaseStackPorts([41601]);
      await new Promise<void>((res) => blocker.close(() => res()));
    }
  });
});

describe("createStackPortAllocator — legacy (no range) mode", () => {
  it("returns distinct bindable ephemeral ports", async () => {
    const allocate = createStackPortAllocator({ range: null });
    const ports = await allocate(["a", "b", "c"]);
    const values = Object.values(ports);
    expect(new Set(values).size).toBe(values.length);
    for (const p of values) expect(Number.isInteger(p) && p > 0).toBe(true);
    releaseStackPorts(values);
  });

  it("returns an empty map for no (or blank) names", async () => {
    const allocate = createStackPortAllocator({ range: null });
    expect(await allocate([])).toEqual({});
    expect(await allocate(["", "  "])).toEqual({});
  });
});
