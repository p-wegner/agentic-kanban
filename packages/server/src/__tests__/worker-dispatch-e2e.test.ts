// Phase 1c end-to-end (worker fleet #5): a session launched through the
// dispatch proxy with a remote placement actually executes on a connected
// worker daemon (real WS, real spawned mock agent) and its output/exit events
// come back through the normal AgentOutputCallback. Also covers stop().

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkersRoute } from "../routes/workers.js";
import { createWorkerWsRoute } from "../services/worker-connection.service.js";
import { getWorkerFleet, type WorkerFleet } from "../services/worker-fleet.service.js";
import { createAgentDispatch, type AgentExecutionService } from "../services/agent-dispatch.service.js";
import { startWorkerDaemon, type WorkerDaemonHandle } from "../worker/worker-daemon.js";
import type { AgentOutputEvent } from "../services/agent.service.js";
import type { Database } from "../db/index.js";

const hostStub = new Proxy({}, {
  get: (_t, prop) => () => {
    throw new Error(`host implementation must not be used in this test (called ${String(prop)})`);
  },
}) as AgentExecutionService;

describe("worker dispatch e2e (phase 1c)", () => {
  let db: Database;
  let fleet: WorkerFleet;
  let server: ReturnType<typeof serve>;
  let boardUrl: string;
  let daemon: WorkerDaemonHandle;
  let dispatch: AgentExecutionService;
  const stateFile = join(tmpdir(), `worker-dispatch-e2e-${randomUUID()}.json`);
  // "mock-agent" in the path selects the provider's mock launch path (argv-free,
  // prompt via stdin) — exactly what a hand-rolled echo script wants.
  const scriptPath = join(tmpdir(), `fleet-mock-agent-${randomUUID()}.cjs`);

  beforeAll(async () => {
    db = createTestDb().db as unknown as Database;
    fleet = getWorkerFleet(db);
    dispatch = createAgentDispatch({ host: hostStub, remote: fleet.remoteAgentService });

    writeFileSync(
      scriptPath,
      `let b="";process.stdin.on("data",(d)=>b+=d);` +
      `process.stdin.on("end",()=>{console.log("MOCK-RAN:"+b.trim());process.exit(0);});`,
    );

    const app = new Hono();
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
    app.route("/api/workers", createWorkersRoute(db, fleet.registry));
    app.get("/ws/workers/:id", createWorkerWsRoute(upgradeWebSocket, fleet.registry, fleet.connections));
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        boardUrl = `http://127.0.0.1:${info.port}`;
        resolve();
      });
    });
    injectWebSocket(server);

    const { pairingToken } = fleet.registry.mintPairingToken();
    daemon = await startWorkerDaemon({
      boardUrl, pairingToken, name: "e2e-worker", providers: ["claude"], stateFile, log: () => {},
    });
    await daemon.connected;
  });

  afterAll(async () => {
    daemon.stop({ killAgents: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(stateFile, { force: true });
    rmSync(scriptPath, { force: true });
  });

  function launchRemote(sessionId: string, onOutput: (e: AgentOutputEvent) => void, keepAlive = false) {
    return dispatch.launch({
      worktreePath: tmpdir(), sessionId, prompt: "the-prompt", agentArgs: undefined, onOutput,
      agentCommand: `node ${scriptPath}`, keepAlive,
      placement: { kind: "remote", workerId: daemon.workerId },
    });
  }

  it("runs a dispatched session on the worker and streams events back", async () => {
    const events: AgentOutputEvent[] = [];
    launchRemote(`sess-${randomUUID()}`, (e) => events.push(e));

    await vi.waitFor(() => expect(events.some((e) => e.type === "exit")).toBe(true), { timeout: 20000 });
    const stdout = events.filter((e) => e.type === "stdout").map((e) => e.data).join("");
    expect(stdout).toContain("MOCK-RAN:the-prompt");
    expect(events.find((e) => e.type === "exit")!.exitCode).toBe(0);
  });

  it("stops a dispatched multi-turn session via the dispatch proxy", async () => {
    const sessionId = `sess-${randomUUID()}`;
    const events: AgentOutputEvent[] = [];
    // keepAlive keeps stdin open, so the script never sees EOF and idles.
    launchRemote(sessionId, (e) => events.push(e), true);
    await new Promise((r) => setTimeout(r, 500));
    expect(events.some((e) => e.type === "exit")).toBe(false);

    expect(dispatch.kill(sessionId)).toBe(true);
    await vi.waitFor(() => expect(events.some((e) => e.type === "exit")).toBe(true), { timeout: 20000 });
  });
}, 60000);
