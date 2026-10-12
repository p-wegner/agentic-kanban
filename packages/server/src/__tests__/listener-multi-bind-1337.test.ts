// #1337 — each listener accepts a comma-separated address list and binds every entry; the default
// stays closed; a non-tailnet, non-loopback entry logs a loud warning.

import { describe, it, expect, afterEach, vi } from "vitest";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import { startFleetListener, resolveFleetHost, type FleetListenerHandle } from "../services/fleet-listener.service.js";
import { startGitHttpServer, resolveConfiguredGitHost, type GitHttpHandle } from "../services/git-http.service.js";
import { createFleetWorkersRoute } from "../routes/workers.js";
import {
  exposedBindHosts,
  isLoopbackAddress,
  isTailnetAddress,
  parseHostList,
  resolveBindHosts,
  warnOnNonTailnetBinds,
} from "../lib/listen-hosts.js";

describe("host list parsing (#1337)", () => {
  it("splits on commas, trims, drops empties and duplicates, keeps order", () => {
    expect(parseHostList("100.64.0.1, 192.168.0.198 ,,100.64.0.1")).toEqual(["100.64.0.1", "192.168.0.198"]);
    expect(parseHostList("127.0.0.1")).toEqual(["127.0.0.1"]);
  });

  it("resolves the tailscale keyword per entry and leaves literals alone", () => {
    const resolve = (h: string) => (h === "tailscale" ? "100.101.102.103" : h);
    expect(resolveBindHosts("tailscale,192.168.0.198", resolve)).toEqual(["100.101.102.103", "192.168.0.198"]);
  });

  it("the env resolvers pass a list through verbatim; the default is still loopback", () => {
    expect(resolveFleetHost({ KANBAN_FLEET_HOST: "100.64.0.1,192.168.0.198" })).toBe("100.64.0.1,192.168.0.198");
    expect(resolveConfiguredGitHost({ KANBAN_GIT_HTTP_HOST: "100.64.0.1,192.168.0.198" })).toBe("100.64.0.1,192.168.0.198");
    expect(resolveFleetHost({})).toBe("127.0.0.1");
    expect(resolveFleetHost({ KANBAN_FLEET_INSECURE: "1" })).toBe("0.0.0.0");
  });
});

describe("non-tailnet bind warning (#1337)", () => {
  it("classifies loopback, tailnet and LAN addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isTailnetAddress("100.101.102.103")).toBe(true);
    expect(isTailnetAddress("192.168.0.198")).toBe(false);
    expect(exposedBindHosts(["127.0.0.1", "100.101.102.103", "192.168.0.198"])).toEqual(["192.168.0.198"]);
  });

  it("warns loudly for a LAN address and stays quiet for tailnet/loopback only", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(warnOnNonTailnetBinds("[t]", ["127.0.0.1", "100.64.0.1"])).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      expect(warnOnNonTailnetBinds("[t]", ["100.64.0.1", "192.168.0.198"])).toEqual(["192.168.0.198"]);
      const text = String(warn.mock.calls[0]?.[0]);
      expect(text).toContain("WARNING");
      expect(text).toContain("192.168.0.198");
      expect(text).toContain("Private profile");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("multi-address bind (#1337)", () => {
  let fleet: FleetListenerHandle | undefined;
  let git: GitHttpHandle | undefined;

  afterEach(async () => {
    await fleet?.close();
    await git?.close();
    fleet = undefined;
    git = undefined;
  });

  it("the fleet listener answers on every listed address, on one port, and reports the board id", async () => {
    const db = createTestDb().db as unknown as Database;
    fleet = await startFleetListener({
      database: db, port: 0, host: "127.0.0.1,127.0.0.2", createWorkersRoute: createFleetWorkersRoute,
    });
    expect(fleet.hosts).toEqual(["127.0.0.1", "127.0.0.2"]);
    const ids: unknown[] = [];
    for (const host of fleet.hosts) {
      const res = await fetch(`http://${host}:${fleet.port}/health`);
      expect(res.status).toBe(200);
      ids.push(((await res.json()) as { boardId?: string }).boardId);
    }
    expect(typeof ids[0]).toBe("string");
    expect(ids[1]).toBe(ids[0]); // one board, one identity, whichever address answers
  });

  it("a failing address closes the ones already bound and propagates", async () => {
    const db = createTestDb().db as unknown as Database;
    const first = await startFleetListener({
      database: db, port: 0, host: "127.0.0.1", createWorkersRoute: createFleetWorkersRoute,
    });
    try {
      // Same port on 127.0.0.1 is already taken by `first`, so the second entry fails.
      await expect(
        startFleetListener({
          database: db, port: first.port, host: "127.0.0.2,127.0.0.1", createWorkersRoute: createFleetWorkersRoute,
        }),
      ).rejects.toThrow();
      // 127.0.0.2:<port> was released again, not left half-exposed.
      await expect(fetch(`http://127.0.0.2:${first.port}/health`)).rejects.toThrow();
    } finally {
      await first.close();
    }
  });

  it("the git transport binds every listed address on one port", async () => {
    const db = createTestDb().db as unknown as Database;
    git = await startGitHttpServer({ database: db, port: 0, host: "127.0.0.1,127.0.0.2" });
    for (const host of ["127.0.0.1", "127.0.0.2"]) {
      const res = await fetch(`http://${host}:${git.port}/health`);
      expect(res.status).toBe(200);
    }
  });
});
