// #1354: a signalled board shutdown sends every connected worker a 1001 (Going Away) close
// frame, so the worker logs a clean "board restarting" instead of `1006 no close frame`.
import { describe, it, expect, vi, afterEach } from "vitest";
import type { WSContext } from "hono/ws";
import { createWorkerConnectionManager } from "../services/worker-connection.service.js";
import type { WorkerRegistry } from "../services/worker-registry.service.js";

const fleet = vi.hoisted(() => ({ close: null as null | (() => number) }));

vi.mock("../services/worker-fleet.service.js", () => ({
  closeAllWorkerSockets: () => fleet.close?.() ?? 0,
}));
vi.mock("../db/index.js", () => ({
  rawClient: { execute: async () => ({}) },
  rawWriteClient: { execute: async () => ({}) },
}));
vi.mock("../db/backup.js", () => ({ createBackup: async () => {} }));
vi.mock("../services/mcp-http-bridge.service.js", () => ({ stopMcpHttpBridge: () => {} }));
vi.mock("../services/git-http.service.js", () => ({ stopGitHttpServer: async () => {} }));
vi.mock("../services/plugin.service.js", () => ({ stopAllPluginViewsAsync: async () => 0 }));
vi.mock("../lib/exit-record.js", () => ({ appendExitRecord: () => {}, recordProcessStart: () => {} }));

import { setupProcessHandlers } from "../startup/process-handlers.js";

function fakeRegistry(): WorkerRegistry {
  return { onRevoke: () => {}, touchHeartbeat: async () => {}, noteAttestedProfiles: () => {}, notePackageManagers: () => {}, noteProviderNotice: () => {}, noteDoctor: () => {} } as unknown as WorkerRegistry;
}

afterEach(() => vi.restoreAllMocks());

describe("shutdown closes worker sockets (#1354)", () => {
  it("SIGTERM closes a connected fake worker with code 1001 before the server closes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const mgr = createWorkerConnectionManager(fakeRegistry());
    const close = vi.fn();
    mgr.handleOpen("w1", { send: () => {}, close, raw: {} } as unknown as WSContext);
    fleet.close = () => mgr.closeAll();

    const order: string[] = [];
    close.mockImplementation(() => order.push("worker-close"));
    const server = { close: (cb: () => void) => { order.push("server-close"); cb(); } };
    const before = process.listeners("SIGTERM");
    setupProcessHandlers(server, { killAll: () => 0 } as never);
    const handler = process.listeners("SIGTERM").find((l) => !before.includes(l))!;
    handler("SIGTERM");

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 15000 });
    expect(close).toHaveBeenCalledWith(1001, "board restarting");
    expect(order).toEqual(["worker-close", "server-close"]);
    process.removeListener("SIGTERM", handler);
  }, 30000);
});
