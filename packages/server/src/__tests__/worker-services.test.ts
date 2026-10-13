/**
 * #1447 — workspace services on a worker + the board's port proxy, end to end over an in-memory
 * stand-in for the fleet socket: the board's client talks to the worker's runner through the REAL
 * frame codecs, against a real local HTTP + WebSocket server standing in for the dev server.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  parseBoardToWorkerMessage,
  parseWorkerToBoardMessage,
  type BoardToWorkerMessage,
  type WorkerToBoardMessage,
} from "@agentic-kanban/shared/lib/worker-protocol";
import { createWorkerServicesRunner } from "../worker/worker-services.js";
import { createWorkerServicesClient } from "../services/worker-services-client.js";
import type { WorkerConnectionManager } from "../services/worker-connection.service.js";

const WORKER = "w1";
let checkout: string;
let upstream: Server;
let wss: WebSocketServer;
let port: number;
let runner: ReturnType<typeof createWorkerServicesRunner>;
let toBoard: Array<(workerId: string, m: WorkerToBoardMessage) => void>;
let disconnects: Array<(workerId: string) => void>;

function fakeManager(): WorkerConnectionManager {
  return {
    send: (_id: string, message: BoardToWorkerMessage) => {
      const parsed = parseBoardToWorkerMessage(JSON.stringify(message));
      if (!parsed) throw new Error(`board frame did not survive the codec: ${message.type}`);
      queueMicrotask(() => { runner.handle(parsed); });
      return true;
    },
    onMessage: (l: (workerId: string, m: WorkerToBoardMessage) => void) => { toBoard.push(l); return () => undefined; },
    onDisconnect: (l: (workerId: string) => void) => { disconnects.push(l); return () => undefined; },
  } as unknown as WorkerConnectionManager;
}

beforeEach(async () => {
  checkout = mkdtempSync(join(tmpdir(), "ak-svc-test-"));
  toBoard = [];
  disconnects = [];
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("set-cookie", ["a=1", "b=2"]);
      res.setHeader("x-seen-host", String(req.headers.host));
      res.setHeader("x-seen-prefix", String(req.headers["x-forwarded-prefix"] ?? ""));
      res.statusCode = 201;
      res.end(`${req.method} ${req.url} body=${Buffer.concat(chunks).toString()}`);
    });
  });
  wss = new WebSocketServer({ server: upstream });
  wss.on("connection", (ws) => ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary })));
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  port = (upstream.address() as AddressInfo).port;
  runner = createWorkerServicesRunner({
    send: (m) => {
      const parsed = parseWorkerToBoardMessage(JSON.stringify(m));
      if (!parsed) throw new Error(`worker frame did not survive the codec: ${m.type}`);
      for (const l of toBoard) l(WORKER, parsed);
    },
    cwdForSession: (id) => (id === "s1" ? checkout : undefined),
  });
});

afterEach(async () => {
  await runner.stopAll();
  wss.close();
  await new Promise<void>((r) => upstream.close(() => r()));
  rmSync(checkout, { recursive: true, force: true });
});

const LONG_RUNNING = `"${process.execPath}" -e "setInterval(() => {}, 1000)"`;

describe("workspace services on a worker (#1447)", () => {
  it("starts a long-running service in the session's checkout and records it as running", async () => {
    const client = createWorkerServicesClient(fakeManager());
    const result = await client.startProcess({ workerId: WORKER, sessionId: "s1", workspaceId: "ws1", label: "devserver", command: LONG_RUNNING, ports: [port] });
    expect(result.ok).toBe(true);
    expect(result.pid).toBeGreaterThan(0);
    expect(client.listServices("ws1")).toMatchObject([{ label: "devserver", workerId: WORKER, status: "running", ports: [port] }]);
    expect(client.workerForPort("ws1", port)).toBe(WORKER);
    await client.stopServices(WORKER, "ws1");
  });

  it("refuses a session this worker holds no checkout for, and records nothing", async () => {
    const client = createWorkerServicesClient(fakeManager());
    const result = await client.startProcess({ workerId: WORKER, sessionId: "nope", workspaceId: "ws1", label: "devserver", command: LONG_RUNNING, ports: [port] });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("no checkout") });
    expect(client.listServices("ws1")).toEqual([]);
  });

  it("refuses a working directory that leaves the checkout", async () => {
    const client = createWorkerServicesClient(fakeManager());
    const result = await client.startProcess({ workerId: WORKER, sessionId: "s1", workspaceId: "ws1", label: "x", command: LONG_RUNNING, ports: [], cwdRel: "../.." });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("outside") });
  });

  it("tunnels an HTTP request to the registered port, with body, status and every set-cookie", async () => {
    const client = createWorkerServicesClient(fakeManager());
    await client.startProcess({ workerId: WORKER, sessionId: "s1", workspaceId: "ws1", label: "devserver", command: LONG_RUNNING, ports: [port] });
    const res = await client.proxyHttp(WORKER, {
      workspaceId: "ws1", port, method: "POST", path: "/api/x?y=1",
      headers: { "content-type": "text/plain", "x-forwarded-prefix": "/api/workspaces/ws1/proxy/1" }, bodyB64: Buffer.from("hello").toString("base64"),
    });
    expect(res.status).toBe(201);
    expect(Buffer.from(res.bodyB64 ?? "", "base64").toString()).toBe("POST /api/x?y=1 body=hello");
    expect(res.headers["set-cookie"]).toBe("a=1\nb=2");
    expect(res.headers["x-seen-host"]).toBe(`127.0.0.1:${port}`);
    expect(res.headers["x-seen-prefix"]).toBe("/api/workspaces/ws1/proxy/1");
    await client.stopServices(WORKER, "ws1");
  });

  it("will not dial a port that no service of THAT workspace registered", async () => {
    const client = createWorkerServicesClient(fakeManager());
    await client.startProcess({ workerId: WORKER, sessionId: "s1", workspaceId: "ws1", label: "devserver", command: LONG_RUNNING, ports: [port] });
    const other = await client.proxyHttp(WORKER, { workspaceId: "ws2", port, method: "GET", path: "/", headers: {} });
    expect(other.status).toBe(403);
    const unregistered = await client.proxyHttp(WORKER, { workspaceId: "ws1", port: port + 1, method: "GET", path: "/", headers: {} });
    expect(unregistered.status).toBe(403);
    await client.stopServices(WORKER, "ws1");
  });

  it("bridges a WebSocket upgrade in both directions, text and binary", async () => {
    const client = createWorkerServicesClient(fakeManager());
    await client.startProcess({ workerId: WORKER, sessionId: "s1", workspaceId: "ws1", label: "devserver", command: LONG_RUNNING, ports: [port] });
    const got: Array<{ text: string; binary: boolean }> = [];
    const opened = await client.openProxySocket(WORKER, { workspaceId: "ws1", port, path: "/", headers: {} }, {
      onData: (data, binary) => got.push({ text: data.toString("utf8"), binary }),
      onClose: () => undefined,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    opened.socket.send(Buffer.from("ping"), false);
    opened.socket.send(Buffer.from([1, 2, 3]), true);
    await expect.poll(() => got.length).toBe(2);
    expect(got[0]).toEqual({ text: "ping", binary: false });
    expect(got[1]).toEqual({ text: "\u0001\u0002\u0003", binary: true });
    opened.socket.close();
    await client.stopServices(WORKER, "ws1");
  });

  it("refuses a WebSocket to an unregistered port", async () => {
    const client = createWorkerServicesClient(fakeManager());
    const opened = await client.openProxySocket(WORKER, { workspaceId: "ws1", port, path: "/", headers: {} }, { onData: () => undefined, onClose: () => undefined });
    expect(opened).toMatchObject({ ok: false, error: expect.stringContaining("not registered") });
  });

  it("marks a worker's services unreachable when its connection drops", async () => {
    const client = createWorkerServicesClient(fakeManager());
    await client.startProcess({ workerId: WORKER, sessionId: "s1", workspaceId: "ws1", label: "devserver", command: LONG_RUNNING, ports: [port] });
    for (const l of disconnects) l(WORKER);
    expect(client.listServices("ws1")[0]?.status).toBe("unreachable");
    await runner.stopAll();
  });

  it("stops the process on the worker and forgets the record", async () => {
    const client = createWorkerServicesClient(fakeManager());
    const started = await client.startProcess({ workerId: WORKER, sessionId: "s1", workspaceId: "ws1", label: "devserver", command: LONG_RUNNING, ports: [port] });
    const result = await client.stopServices(WORKER, "ws1");
    expect(result.ok).toBe(true);
    expect(client.listServices("ws1")).toEqual([]);
    await expect.poll(() => { try { process.kill(started.pid!, 0); return true; } catch { return false; } }, { timeout: 8000 }).toBe(false);
  });

  it("runs an exec job to completion and reports its output and exit code", async () => {
    const client = createWorkerServicesClient(fakeManager());
    const ok = await client.exec({ workerId: WORKER, sessionId: "s1", workspaceId: "ws1", label: "script:a", command: `"${process.execPath}" -e "console.log('hi')"` });
    expect(ok).toMatchObject({ ok: true, code: 0 });
    expect(ok.stdout).toContain("hi");
    const bad = await client.exec({ workerId: WORKER, sessionId: "s1", workspaceId: "ws1", label: "script:b", command: `"${process.execPath}" -e "process.exit(3)"` });
    expect(bad).toMatchObject({ ok: false, code: 3 });
  });

  it("materialises an exec job's env file on the worker for the @ENVFILE argv entry", async () => {
    const client = createWorkerServicesClient(fakeManager());
    const res = await client.exec({
      workerId: WORKER, sessionId: "s1", workspaceId: "ws1", label: "compose-up", envFile: "A=1\n",
      argv: [process.execPath, "-e", "console.log(require('fs').readFileSync(process.argv[1], 'utf8'))", "@ENVFILE"],
    });
    expect(res.ok).toBe(true);
    expect(res.stdout).toContain("A=1");
  });
});
