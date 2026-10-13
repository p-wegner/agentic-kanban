/**
 * #1447 — where a workspace's dev server starts follows where its builder is placed: ON the worker
 * (named in board.log) for a worker-placed workspace, with NOTHING spawned on the host; the old host
 * path for a host-placed one. And the proxy route that fronts the worker-side port.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const placement = vi.hoisted(() => ({ remote: null as unknown, services: [] as unknown[], byPort: null as unknown }));

vi.mock("../repositories/workspace.repository.js", () => ({
  getWorkspaceById: async (id: string) => ({ id, workingDir: "/host/worktree" }),
}));
vi.mock("../services/workspace-remote-placement.js", () => ({
  resolveRemotePlacement: async () => placement.remote,
  listRemoteServices: () => placement.services,
  remoteClients: () => [],
  findRemoteServiceByPort: () => placement.byPort,
  workspaceProxyPath: (id: string, port: number) => `/api/workspaces/${id}/proxy/${port}/`,
}));

import { createWorkspaceDevServerService } from "../services/workspace-dev-server.service.js";
import { createWorkspaceProxyRoute } from "../routes/workspace-proxy.js";
import type { Database } from "../db/index.js";

const plan = { command: "pnpm dev", healthUrl: null, port: 5173, isWeb: true, source: { command: "profile", healthUrl: "none", port: "profile" } };
const getPlan = async (id: string) => ({ workspaceId: id, isSelfProject: false, plan } as never);

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => undefined); placement.remote = null; placement.services = []; placement.byPort = null; });
afterEach(() => { log.mockRestore(); });

describe("workspace dev server placement (#1447)", () => {
  it("starts on the worker holding the session, names the worker in the log, and spawns nothing on the host", async () => {
    const startProcess = vi.fn(async () => ({ type: "service_result", requestId: "r", ok: true, pid: 4242 }));
    placement.remote = { workerId: "w-7", sessionId: "s-1", client: { startProcess } };
    const startHost = vi.fn();
    const service = createWorkspaceDevServerService({ database: {} as Database, getPlan, startHost: startHost as never });

    await service.start("ws1");

    expect(startHost).not.toHaveBeenCalled();
    expect(startProcess).toHaveBeenCalledWith(expect.objectContaining({ workerId: "w-7", sessionId: "s-1", workspaceId: "ws1", label: "devserver", command: "pnpm dev", ports: [5173] }));
    expect(log.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toMatch(/workspace ws1 on worker w-7/);
  });

  it("answers with the board proxy URL for a worker-side server, and says so when the worker is unreachable", async () => {
    placement.services = [{ label: "devserver", workerId: "w-7", ports: [5173], status: "unreachable" }];
    const service = createWorkspaceDevServerService({ database: {} as Database, getPlan });
    expect(await service.status("ws1")).toMatchObject({ where: "worker", workerId: "w-7", status: "unreachable", url: "/api/workspaces/ws1/proxy/5173/" });
  });

  it("surfaces a worker-side start failure instead of falling back to the host", async () => {
    placement.remote = { workerId: "w-7", sessionId: "s-1", client: { startProcess: async () => ({ ok: false, error: "no checkout" }) } };
    const startHost = vi.fn();
    const service = createWorkspaceDevServerService({ database: {} as Database, getPlan, startHost: startHost as never });
    await expect(service.start("ws1")).rejects.toThrow(/worker w-7.*no checkout/);
    expect(startHost).not.toHaveBeenCalled();
  });

  it("keeps the host path for a host-placed workspace", async () => {
    const startHost = vi.fn(() => ({ pid: 99, logPath: "/tmp/x.log", command: "pnpm dev" }));
    const stopHost = vi.fn(async () => 1);
    const service = createWorkspaceDevServerService({ database: {} as Database, getPlan, startHost: startHost as never, stopHost: stopHost as never });

    const started = await service.start("ws-host");
    expect(startHost).toHaveBeenCalledWith(plan, "/host/worktree", expect.anything());
    expect(started).toMatchObject({ where: "host", status: "running", port: 5173 });

    expect(await service.stop("ws-host")).toMatchObject({ where: null, status: "stopped" });
    expect(stopHost).toHaveBeenCalledWith(plan);
  });
});

describe("workspace proxy route (#1447)", () => {
  function app(): Hono {
    const a = new Hono();
    a.route("/api/workspaces", createWorkspaceProxyRoute((() => () => { throw new Error("no upgrade in this test"); }) as never));
    return a;
  }

  it("forwards the request under the board prefix and relays status, body and each set-cookie", async () => {
    const proxyHttp = vi.fn(async () => ({
      type: "proxy_http_result", proxyId: "p", status: 201,
      headers: { "set-cookie": "a=1\nb=2", "content-type": "text/plain" }, bodyB64: Buffer.from("ok").toString("base64"),
    }));
    placement.byPort = { record: { workerId: "w-7", ports: [5173], status: "running" }, client: { proxyHttp } };

    const res = await app().request("/api/workspaces/ws1/proxy/5173/assets/app.js?v=2", { method: "POST", body: "payload", headers: { "content-type": "text/plain" } });

    expect(res.status).toBe(201);
    expect(await res.text()).toBe("ok");
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect(proxyHttp).toHaveBeenCalledWith("w-7", expect.objectContaining({
      workspaceId: "ws1", port: 5173, method: "POST", path: "/assets/app.js?v=2",
      bodyB64: Buffer.from("payload").toString("base64"),
      headers: expect.objectContaining({ "x-forwarded-prefix": "/api/workspaces/ws1/proxy/5173" }),
    }));
  });

  it("treats the bare prefix as the app root", async () => {
    const proxyHttp = vi.fn(async () => ({ type: "proxy_http_result", proxyId: "p", status: 200, headers: {}, bodyB64: "" }));
    placement.byPort = { record: { workerId: "w-7", ports: [5173], status: "running" }, client: { proxyHttp } };
    await app().request("/api/workspaces/ws1/proxy/5173");
    expect(proxyHttp).toHaveBeenCalledWith("w-7", expect.objectContaining({ path: "/" }));
  });

  it("404s a port no service of the workspace registered, without asking any worker", async () => {
    const res = await app().request("/api/workspaces/ws1/proxy/9999/");
    expect(res.status).toBe(404);
  });

  it("502s while the worker is unreachable", async () => {
    placement.byPort = { record: { workerId: "w-7", ports: [5173], status: "unreachable" }, client: { proxyHttp: vi.fn() } };
    const res = await app().request("/api/workspaces/ws1/proxy/5173/");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("unreachable") });
  });

  it("502s with the worker's reason when the upstream cannot be reached", async () => {
    const proxyHttp = async () => ({ type: "proxy_http_result", proxyId: "p", status: 502, headers: {}, error: "worker could not reach 127.0.0.1:5173" });
    placement.byPort = { record: { workerId: "w-7", ports: [5173], status: "running" }, client: { proxyHttp } };
    const res = await app().request("/api/workspaces/ws1/proxy/5173/");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("could not reach") });
  });
});
