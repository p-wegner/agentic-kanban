// End-to-end same-machine fleet test (worker fleet phase 1b #4): a real Hono
// board surface (workers REST + WS upgrade) on an OS-assigned port, a real
// worker daemon process-in-process, a real spawned mock agent. Verifies the
// whole protocol loop: pair → register → connect → hello → assign → streamed
// stdout → exit — plus WS auth rejection.

import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createWorkersRoute } from "../routes/workers.js";
import { createWorkerRegistry, type WorkerRegistry } from "../services/worker-registry.service.js";
import {
  createWorkerConnectionManager,
  createWorkerWsRoute,
  type WorkerConnectionManager,
} from "../services/worker-connection.service.js";
import { startWorkerDaemon, type WorkerDaemonHandle } from "../worker/worker-daemon.js";
import type { WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import type { Database } from "../db/index.js";

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined),
) as Record<string, string>;

describe("worker fleet integration (board <-> daemon <-> agent)", () => {
  let db: TestDb;
  let registry: WorkerRegistry;
  let manager: WorkerConnectionManager;
  let server: ReturnType<typeof serve>;
  let boardUrl: string;
  let daemon: WorkerDaemonHandle | undefined;
  // #839 — these fixture files live INSIDE an `ak-` DIRECTORY rather than loose in
  // `%TEMP%`, because the reaper (`helpers/reap-fixture-child-servers.ts`) only sweeps
  // entries where `statSync(...).isDirectory()` — files are excluded on purpose, since
  // `kanban-session-*.out` transcripts are read by a running server. A loose fixture file
  // was therefore in NO swept namespace and a failed teardown leaked it permanently.
  const fixtureDir = mkdtempSync(join(tmpdir(), "ak-worker-fleet-test-"));
  const stateFile = join(fixtureDir, `worker-state-${randomUUID()}.json`);
  const received: Array<{ workerId: string; message: WorkerToBoardMessage }> = [];

  beforeAll(async () => {
    db = createTestDb().db;
    registry = createWorkerRegistry(db as unknown as Database);
    manager = createWorkerConnectionManager(registry);

    const app = new Hono();
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
    app.route("/api/workers", createWorkersRoute(db as unknown as Database, registry));
    app.get("/ws/workers/:id", createWorkerWsRoute(upgradeWebSocket, registry, manager));

    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        boardUrl = `http://127.0.0.1:${info.port}`;
        resolve();
      });
    });
    injectWebSocket(server);

    manager.onMessage((workerId, message) => received.push({ workerId, message }));
  });

  afterAll(async () => {
    // `stop()` is ASYNC and DRAINS (#754). Unawaited it both races the teardown below and
    // leaves its promise unhandled, so a rejection in shutdown is reported against whatever
    // file vitest runs NEXT — the cross-file misattribution of #680 (#777, #816).
    await daemon?.stop({ killAgents: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("rejects a WS upgrade without a valid token", async () => {
    const ws = new WebSocket(`${boardUrl.replace("http", "ws")}/ws/workers/some-id?token=wrong`);
    const outcome = await new Promise<string>((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("rejected"));
    });
    expect(outcome).toBe("rejected");
  });

  it("refuses a token in the query string, accepts the header, and closes the socket on revoke", async () => {
    const { pairingToken } = registry.mintPairingToken();
    const registered = await registry.registerWorker({ pairingToken, name: "revoke-me" });
    if (!registered.ok) throw new Error(registered.error);
    const wsBase = `${boardUrl.replace("http", "ws")}/ws/workers/${registered.workerId}`;

    // A VALID token passed as ?token= must still be refused: query strings land
    // in proxy/access logs, and the bundled daemon always uses the header.
    const viaQuery = new WebSocket(`${wsBase}?token=${registered.workerToken}`);
    const queryOutcome = await new Promise<string>((resolve) => {
      viaQuery.on("open", () => resolve("open"));
      viaQuery.on("error", () => resolve("rejected"));
    });
    expect(queryOutcome).toBe("rejected");

    const viaHeader = new WebSocket(wsBase, {
      headers: { authorization: `Bearer ${registered.workerToken}` },
    });
    await new Promise<void>((resolve, reject) => {
      viaHeader.on("open", () => resolve());
      viaHeader.on("error", reject);
    });
    await vi.waitFor(() => expect(manager.isConnected(registered.workerId)).toBe(true));

    // Revoking must take effect at once: the already-upgraded socket is never
    // re-authenticated, so leaving it open let a revoked worker keep streaming.
    const closed = new Promise<void>((resolve) => viaHeader.on("close", () => resolve()));
    expect(await registry.revokeWorker(registered.workerId)).toBe(true);
    expect(manager.isConnected(registered.workerId)).toBe(false);
    await closed;
  }, 20000);

  it("pairs, connects, and says hello", async () => {
    const { pairingToken } = registry.mintPairingToken();
    daemon = await startWorkerDaemon({
      boardUrl,
      pairingToken,
      name: "test-worker",
      labels: ["test"],
      providers: ["claude"],
      stateFile,
      // Temp work root (#871): keep the undelivered-results file out of the real one.
      workRoot: mkdtempSync(join(tmpdir(), "ak-worker-root-")),
      log: () => {},
    });
    await daemon.connected;

    expect(manager.isConnected(daemon.workerId)).toBe(true);
    await vi.waitFor(() => {
      expect(received.some((r) => r.message.type === "hello" && r.workerId === daemon!.workerId)).toBe(true);
    });

    const workers = await registry.listWorkersView();
    expect(workers).toHaveLength(1);
    expect(workers[0].name).toBe("test-worker");
    expect(workers[0].effectiveStatus).toBe("online");
  });

  it("executes an assignment and streams events back to the board", async () => {
    const sessionId = `sess-${randomUUID()}`;
    const sent = manager.send(daemon!.workerId, {
      type: "assign",
      sessionId,
      spec: {
        command: process.execPath,
        args: ["-e", "console.log('fleet-hello:'+process.cwd().length)"],
        env: cleanEnv,
        cwd: tmpdir(),
        stdinPrompt: "",
      },
    });
    expect(sent).toBe(true);

    await vi.waitFor(() => {
      const events = received.flatMap((r) =>
        r.message.type === "event" && r.message.event.sessionId === sessionId ? [r.message.event] : [],
      );
      expect(events.some((e) => e.type === "exit")).toBe(true);
    }, { timeout: 20000 });

    const events = received.flatMap((r) =>
      r.message.type === "event" && r.message.event.sessionId === sessionId ? [r.message.event] : [],
    );
    const stdout = events.filter((e) => e.type === "stdout").map((e) => e.data).join("");
    expect(stdout).toContain("fleet-hello:");
    expect(events.find((e) => e.type === "exit")!.exitCode).toBe(0);
    // The board saw the session start and finish in the connection's running set.
    expect(manager.runningSessionIds(daemon!.workerId)).not.toContain(sessionId);
  });

  it("re-registration is not needed on daemon restart (state file reuse)", async () => {
    const firstWorkerId = daemon!.workerId;
    daemon!.stop();
    daemon = await startWorkerDaemon({
      boardUrl, name: "test-worker", stateFile, log: () => {},
      workRoot: mkdtempSync(join(tmpdir(), "ak-worker-root-")), // #871 — see above
    });
    await daemon.connected;
    expect(daemon.workerId).toBe(firstWorkerId);
    expect((await registry.listWorkersView()).length).toBe(1);
  });
}, 60000);
