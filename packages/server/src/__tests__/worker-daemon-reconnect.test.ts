// #858 — overlapping sockets: the daemon's reconnect could fire while a connect attempt
// was already in flight, opening a SECOND socket for the same workerId. The board sanely
// evicts the older one, the eviction looks like a network drop to the daemon, and the two
// ends sustain a connect/evict flap (13 connects / 6 disconnects / 3 evictions in one
// observed log). The daemon-side guarantees pinned here:
//
//   1. at most ONE client socket exists at any moment, across a run of board-initiated
//      closes (the eviction shape);
//   2. the daemon still converges to a stable connection afterwards, i.e. the guard
//      suppresses OVERLAP, not reconnection itself.
//
// #871 — the same harness also pins the reconnect-time report: a daemon that starts while
// its work root holds a persisted completed-but-undelivered result retries the push and,
// when that fails too (a restored entry carries no credential by design), REPORTS it to
// the board as an `undelivered_result` message instead of keeping the loss to itself.
//
// Raw `ws` server rather than the Hono fake board, same as worker-daemon-close-code.test.ts:
// only a server that owns the socket can close/evict it on its own schedule.

import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { parseWorkerToBoardMessage, type WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import { startWorkerDaemon, type WorkerDaemonHandle } from "../worker/worker-daemon.js";
import { upsertUndelivered } from "../worker/worker-undelivered.js";

interface WsBoard {
  url: string;
  /** Every accepted board-side socket, in order. */
  accepted: ServerSocket[];
  /** Client sockets alive right now / the most ever alive at once (#858's number). */
  concurrent: number;
  maxConcurrent: number;
  messages: WorkerToBoardMessage[];
  close(): Promise<void>;
}

async function startWsBoard(): Promise<WsBoard> {
  const state = {
    accepted: [] as ServerSocket[],
    concurrent: 0,
    maxConcurrent: 0,
    messages: [] as WorkerToBoardMessage[],
  };
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (socket: ServerSocket) => {
    state.accepted.push(socket);
    state.concurrent += 1;
    state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
    socket.on("close", () => { state.concurrent -= 1; });
    socket.on("message", (raw) => {
      const parsed = parseWorkerToBoardMessage(String(raw));
      if (parsed) state.messages.push(parsed);
    });
  });
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/workers/register") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ workerId: `w-${randomUUID()}`, workerToken: "tok" }));
      return;
    }
    if (req.method === "POST" && /\/heartbeat$/.test(req.url ?? "")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
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
    get accepted() { return state.accepted; },
    get concurrent() { return state.concurrent; },
    get maxConcurrent() { return state.maxConcurrent; },
    get messages() { return state.messages; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("worker daemon reconnect discipline (#858)", () => {
  let board: WsBoard | undefined;
  let daemon: WorkerDaemonHandle | undefined;
  const fixtureDirs: string[] = [];

  function fixtureDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    fixtureDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await daemon?.stop({ killAgents: true, drainTimeoutMs: 100 }).catch(() => {});
    daemon = undefined;
    await board?.close();
    board = undefined;
    for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("never holds two sockets at once across a run of board-side closes", async () => {
    board = await startWsBoard();
    const logs: string[] = [];
    daemon = await startWorkerDaemon({
      boardUrl: board.url,
      pairingToken: "pair",
      name: "reconnect-worker",
      stateFile: join(fixtureDir("ak-worker-858-"), "worker-state.json"),
      heartbeatIntervalMs: 60 * 60 * 1000,
      log: (line) => logs.push(line),
    });
    await daemon.connected;

    // The eviction shape: the board closes each socket shortly after it opens. Without
    // the reconnect guard this is exactly the input that stacked overlapping connects.
    for (let round = 1; round <= 3; round += 1) {
      const socket = await vi.waitFor(() => {
        expect(board!.accepted.length).toBeGreaterThanOrEqual(round);
        return board!.accepted[round - 1];
      }, { timeout: 15000 });
      socket.close(4000, "evicted: newer connection for this worker id");
    }

    // It reconnects (that is not what the guard suppresses)...
    await vi.waitFor(() => expect(board!.accepted.length).toBeGreaterThanOrEqual(4), { timeout: 20000 });
    // ...but at no moment did two client sockets exist side by side — the overlap that
    // fed the board-side evict loop.
    expect(board.maxConcurrent).toBe(1);
    // And the guard's own suppression path never had to fire spuriously into a flap:
    // a suppressed connect while nothing overlaps would mean the timer bookkeeping leaks.
    expect(logs.filter((l) => l.includes("not retrying — a newer connection attempt already exists")).length).toBe(0);
  }, 40000);

  it("reports a persisted undelivered result to the board when the reconnect retry fails too (#871)", async () => {
    board = await startWsBoard();
    const workRoot = fixtureDir("ak-worker-871-report-");
    const checkout = fixtureDir("ak-worker-871-checkout-");
    // What a previous daemon persisted before dying: token-free, so the retry this daemon
    // makes cannot authenticate — the report is the designed outcome, not a shortcut.
    upsertUndelivered(workRoot, {
      sessionId: "s-undelivered",
      branch: "feature/ak-871",
      baseBranch: "master",
      incomingRef: "refs/kanban/incoming/feature/ak-871",
      checkoutPath: checkout,
      cacheDir: checkout,
      projectId: "p1",
      gitPort: 1, // nothing listens there: the retry push fails fast
      attempts: 6,
      lastError: "connect timeout",
      recordedAt: new Date().toISOString(),
    });

    daemon = await startWorkerDaemon({
      boardUrl: board.url,
      pairingToken: "pair",
      name: "undelivered-worker",
      stateFile: join(fixtureDir("ak-worker-871-state-"), "worker-state.json"),
      workRoot,
      heartbeatIntervalMs: 60 * 60 * 1000,
      log: () => {},
    });
    await daemon.connected;

    const report = await vi.waitFor(() => {
      const found = board!.messages.find((m) => m.type === "undelivered_result");
      expect(found).toBeTruthy();
      return found!;
    }, { timeout: 30000 });
    expect(report).toMatchObject({
      type: "undelivered_result",
      sessionId: "s-undelivered",
      branch: "feature/ak-871",
      incomingRef: "refs/kanban/incoming/feature/ak-871",
      checkoutPath: checkout,
    });
    if (report.type === "undelivered_result") {
      // The retry this process made is counted on top of the persisted six.
      expect(report.attempts).toBeGreaterThanOrEqual(7);
      expect(report.lastError.length).toBeGreaterThan(0);
    }
  }, 60000);
});
