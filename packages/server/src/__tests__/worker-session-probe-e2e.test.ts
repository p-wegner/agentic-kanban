/**
 * #887 end-to-end: the probe round trip over a REAL WebSocket to a REAL worker daemon.
 *
 * The unit suites either side of this one pin the ledger and the board's reaction. Neither
 * proves the thing the ticket actually needs, which is that a `probe_session` sent by the
 * board reaches a running worker daemon, is understood by it, and comes back correlated and
 * correctly answered. Both ends are in this repo, so that is testable here in full — and it
 * is the half a hand-written protocol change most easily gets wrong (a parser that drops the
 * frame silently looks exactly like a worker that is simply old).
 *
 * NOT covered here: deployment to a remote MACHINE. This runs a real daemon in-process
 * against a real board; it is not a claim about any particular worker install.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkersRoute } from "../routes/workers.js";
import { createWorkerWsRoute } from "../services/worker-connection.service.js";
import { getWorkerFleet, type WorkerFleet } from "../services/worker-fleet.service.js";
import { createAgentDispatch, type AgentExecutionService } from "../services/agent-dispatch.service.js";
import { startWorkerDaemon, type WorkerDaemonHandle } from "../worker/worker-daemon.js";
import type { AgentOutputEvent } from "../services/agent.service.js";
import type { WorkerSessionProbe } from "@agentic-kanban/shared/lib/worker-protocol";
import type { Database } from "../db/index.js";

const hostStub = new Proxy({}, {
  get: (_t, prop) => () => {
    throw new Error(`host implementation must not be used in this test (called ${String(prop)})`);
  },
}) as AgentExecutionService;

describe("session probe e2e (#887)", () => {
  let db: Database;
  let fleet: WorkerFleet;
  let server: ReturnType<typeof serve>;
  let boardUrl: string;
  let daemon: WorkerDaemonHandle;
  let dispatch: AgentExecutionService;
  const answers = new Map<string, WorkerSessionProbe>();
  const fixtureDir = mkdtempSync(join(tmpdir(), "ak-worker-probe-e2e-"));
  const stateFile = join(fixtureDir, `worker-state-${randomUUID()}.json`);
  // "mock-agent" in the path selects the provider's mock launch path (argv-free, prompt via
  // stdin) — the same fixture shape worker-dispatch-e2e.test.ts uses.
  const scriptPath = join(fixtureDir, `fleet-mock-agent-${randomUUID()}.cjs`);

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

    // Tap the manager's own message channel: the probe answers are what this suite asserts on,
    // and reading them here rather than through the service keeps the board's REACTION out of
    // the picture — that half is pinned by agent-remote-liveness.test.ts.
    fleet.connections.onMessage((_workerId, message) => {
      if (message.type === "session_probe_result") answers.set(message.probe.requestId, message.probe);
    });

    const { pairingToken } = fleet.registry.mintPairingToken();
    daemon = await startWorkerDaemon({
      boardUrl, pairingToken, name: "probe-e2e-worker", providers: ["claude"],
      // #895: skip the real-machine auth probe — this test's login state is irrelevant.
      attestProviders: false, stateFile,
      maxConcurrency: 1, log: () => {},
      workRoot: mkdtempSync(join(tmpdir(), "ak-worker-root-")),
    });
    await daemon.connected;
  });

  afterAll(async () => {
    await daemon.stop({ killAgents: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function probe(sessionId: string): Promise<WorkerSessionProbe> {
    const requestId = `e2e-${randomUUID()}`;
    expect(fleet.connections.send(daemon.workerId, { type: "probe_session", sessionId, requestId })).toBe(true);
    await vi.waitFor(() => expect(answers.has(requestId)).toBe(true), { timeout: 10000 });
    return answers.get(requestId)!;
  }

  it("answers UNKNOWN for a session id the worker was never sent — the fact the board could not get", async () => {
    // This is the measured 100-minute hang, answered in one round trip.
    const answer = await probe(`never-assigned-${randomUUID()}`);
    expect(answer.state).toBe("unknown");
  });

  it("does NOT answer unknown for a session it really ran, once that session has finished", async () => {
    const sessionId = `sess-${randomUUID()}`;
    const events: AgentOutputEvent[] = [];
    dispatch.launch({
      worktreePath: tmpdir(), sessionId, prompt: "the-prompt", agentArgs: undefined,
      onOutput: (e) => events.push(e), agentCommand: `node ${scriptPath}`, keepAlive: false,
      placement: { kind: "remote", workerId: daemon.workerId },
    });
    await vi.waitFor(() => expect(events.some((e) => e.type === "exit")).toBe(true), { timeout: 20000 });

    const answer = await probe(sessionId);
    expect(answer.state).toBe("exited");
    expect(answer.exitCode).toBe(0);
    // The distinction the whole mechanism rests on: a session the worker ran and one it never
    // heard of must never come back the same way.
    expect((await probe(`never-assigned-${randomUUID()}`)).state).toBe("unknown");
  });

  it("answers RUNNING while the agent is still alive", async () => {
    const sessionId = `sess-${randomUUID()}`;
    const events: AgentOutputEvent[] = [];
    // keepAlive holds stdin open, so the fixture never sees EOF and idles.
    dispatch.launch({
      worktreePath: tmpdir(), sessionId, prompt: "the-prompt", agentArgs: undefined,
      onOutput: (e) => events.push(e), agentCommand: `node ${scriptPath}`, keepAlive: true,
      placement: { kind: "remote", workerId: daemon.workerId },
    });
    await vi.waitFor(async () => expect((await probe(sessionId)).state).toBe("running"), { timeout: 20000 });
    expect(dispatch.kill(sessionId)).toBe(true);
    await vi.waitFor(() => expect(events.some((e) => e.type === "exit")).toBe(true), { timeout: 20000 });
  });
}, 90000);
