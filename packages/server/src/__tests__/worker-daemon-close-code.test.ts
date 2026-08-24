// The daemon's disconnect log has to name WHY the socket went away (#4 follow-up).
//
// A board that deliberately evicts a connection (a second socket for the same
// workerId, a revoked token) and a transport that simply died produce the same
// reconnect loop, so with the close code discarded the two were one
// indistinguishable "disconnected; retrying in 1s" line. These tests pin the
// distinction: a clean close frame reads as "closed by board" and carries the
// board's reason text, a torn-down TCP socket surfaces as 1006.
//
// Deliberately a raw `ws` server rather than the Hono board surface: only a
// server that owns the socket can destroy it without a close frame, which is
// the sole way to make a real 1006 happen.

import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { startWorkerDaemon, type WorkerDaemonHandle } from "../worker/worker-daemon.js";

describe("worker daemon disconnect log", () => {
  let server: Server;
  let boardUrl: string;
  let daemon: WorkerDaemonHandle | undefined;
  const logs: string[] = [];
  /** Every board-side socket the daemon has opened, in order. */
  const accepted: ServerSocket[] = [];
  // #839 — these fixture files live INSIDE an `ak-` DIRECTORY rather than loose in
  // `%TEMP%`, because the reaper (`helpers/reap-fixture-child-servers.ts`) only sweeps
  // entries where `statSync(...).isDirectory()` — files are excluded on purpose, since
  // `kanban-session-*.out` transcripts are read by a running server. A loose fixture file
  // was therefore in NO swept namespace and a failed teardown leaked it permanently.
  const fixtureDir = mkdtempSync(join(tmpdir(), "ak-worker-close-code-"));
  const stateFile = join(fixtureDir, `worker-state-${randomUUID()}.json`);

  const nextSocket = async (n: number): Promise<ServerSocket> => {
    await vi.waitFor(() => expect(accepted.length).toBeGreaterThanOrEqual(n), { timeout: 15000 });
    return accepted[n - 1];
  };

  beforeAll(async () => {
    const wss = new WebSocketServer({ noServer: true });
    wss.on("connection", (socket) => { accepted.push(socket); });

    server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/workers/register") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ workerId: `w-${randomUUID()}`, workerToken: "tok" }));
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
    boardUrl = `http://127.0.0.1:${addr.port}`;

    daemon = await startWorkerDaemon({
      boardUrl,
      pairingToken: "pair",
      name: "close-code-worker",
      stateFile,
      // A heartbeat would only add noise; the WS is what these tests watch.
      heartbeatIntervalMs: 60 * 60 * 1000,
      log: (line) => logs.push(line),
    });
    await daemon.connected;
  }, 30000);

  afterAll(async () => {
    // `stop()` is ASYNC and DRAINS (#754). Unawaited it both races the teardown below and
    // leaves its promise unhandled, so a rejection in shutdown is reported against whatever
    // file vitest runs NEXT — the cross-file misattribution of #680 (#777, #816).
    await daemon?.stop({ killAgents: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("names the board, and quotes its reason, when the board closes cleanly", async () => {
    const first = await nextSocket(1);
    first.close(4001, "evicted by a newer connection");

    const line = await vi.waitFor(() => {
      const found = logs.find((l) => l.includes("disconnected"));
      expect(found).toBeDefined();
      return found!;
    }, { timeout: 15000 });

    expect(line).toContain("code 4001");
    expect(line).toContain("evicted by a newer connection");
    expect(line).toContain("closed by board");
    expect(line).not.toContain("transport failed");
    // The lifetime is the other half of the story: without it a reset backoff
    // makes a long-lived connection look like it died instantly.
    expect(line).toMatch(/up \d+s/);
  }, 30000);

  it("reports 1006 when the transport dies with no close frame", async () => {
    // The daemon reconnects on its own after the clean close above; tear THAT
    // socket down at the TCP level so no close frame is ever sent.
    const second = await nextSocket(2);
    await vi.waitFor(() => expect(logs.filter((l) => l.includes("connected to")).length).toBeGreaterThanOrEqual(2), { timeout: 15000 });
    second.terminate();

    const line = await vi.waitFor(() => {
      const found = logs.filter((l) => l.includes("disconnected")).at(-1);
      expect(found).toContain("code 1006");
      return found!;
    }, { timeout: 15000 });

    expect(line).toContain("transport failed, no close frame");
    expect(line).not.toContain("closed by board");
  }, 30000);
});
