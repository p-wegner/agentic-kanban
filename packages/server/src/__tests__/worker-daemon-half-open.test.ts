// #1376 — a half-open board socket (board restarted, its close/RST never reached the worker)
// used to leave the worker "connected" forever. Two detectors are pinned here:
//   1. worker-side ping with a pong deadline: a board that stops answering pings WITHOUT
//      closing the TCP connection gets the socket terminated and a fresh one opened;
//   2. a heartbeat response carrying `socket:false` makes the worker drop its socket and reconnect.

import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { startWorkerDaemon, type WorkerDaemonHandle } from "../worker/worker-daemon.js";

interface FakeBoard {
  url: string;
  accepted: ServerSocket[];
  setSocketField(value: boolean): void;
  close(): Promise<void>;
}

async function startFakeBoard(opts: { answerPings: boolean }): Promise<FakeBoard> {
  const accepted: ServerSocket[] = [];
  let socketField = true;
  // autoPong:false => the server never answers a ping, yet the TCP connection stays open.
  const wss = new WebSocketServer({ noServer: true, autoPong: opts.answerPings });
  wss.on("connection", (s: ServerSocket) => { accepted.push(s); });
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/workers/register") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ workerId: `w-${randomUUID()}`, workerToken: "tok" }));
      return;
    }
    if (req.method === "POST" && /\/heartbeat$/.test(req.url ?? "")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, socket: socketField }));
      return;
    }
    res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client, req));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("no port");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    accepted,
    setSocketField: (v) => { socketField = v; },
    close: () => {
      for (const s of accepted) s.terminate();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("worker daemon half-open socket detection (#1376)", () => {
  let board: FakeBoard | undefined;
  let daemon: WorkerDaemonHandle | undefined;
  const dirs: string[] = [];

  afterEach(async () => {
    await daemon?.stop({ killAgents: true, drainTimeoutMs: 100 }).catch(() => {});
    daemon = undefined;
    await board?.close();
    board = undefined;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function stateFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "ak-worker-1376-"));
    dirs.push(dir);
    return join(dir, "worker-state.json");
  }

  it("terminates and reconnects when the board stops answering pings without closing", async () => {
    board = await startFakeBoard({ answerPings: false });
    const logs: string[] = [];
    daemon = await startWorkerDaemon({
      boardUrl: board.url,
      pairingToken: "pair",
      name: "half-open-ping",
      stateFile: stateFile(),
      heartbeatIntervalMs: 60 * 60 * 1000,
      pingIntervalMs: 100,
      pongTimeoutMs: 300,
      log: (l) => logs.push(l),
    });
    await daemon.connected;
    await vi.waitFor(() => expect(board!.accepted.length).toBeGreaterThanOrEqual(2), { timeout: 15000 });
    expect(logs.some((l) => l.includes("board socket dead (no pong in") && l.includes("reconnecting"))).toBe(true);
  }, 30000);

  it("does NOT reconnect while the board answers pings", async () => {
    board = await startFakeBoard({ answerPings: true });
    daemon = await startWorkerDaemon({
      boardUrl: board.url,
      pairingToken: "pair",
      name: "healthy-ping",
      stateFile: stateFile(),
      heartbeatIntervalMs: 60 * 60 * 1000,
      pingIntervalMs: 100,
      pongTimeoutMs: 300,
      log: () => {},
    });
    await daemon.connected;
    await new Promise((r) => setTimeout(r, 1200));
    expect(board.accepted.length).toBe(1);
  }, 30000);

  it("drops its socket and reconnects when a heartbeat response says socket:false", async () => {
    board = await startFakeBoard({ answerPings: true });
    board.setSocketField(false);
    const logs: string[] = [];
    daemon = await startWorkerDaemon({
      boardUrl: board.url,
      pairingToken: "pair",
      name: "half-open-heartbeat",
      stateFile: stateFile(),
      heartbeatIntervalMs: 200,
      log: (l) => logs.push(l),
    });
    await daemon.connected;
    await vi.waitFor(() => expect(board!.accepted.length).toBeGreaterThanOrEqual(2), { timeout: 15000 });
    expect(logs.some((l) => l.includes("board reports no socket"))).toBe(true);
  }, 30000);
});
