/**
 * #900 end-to-end: recovering a follow-up turn's stdin state from a REAL worker daemon.
 *
 * #874 fixed the routing (an adopted session resolves to the remote implementation) and the
 * refusal (it stopped lying about an exit), but deliberately left the turn itself refused —
 * the board's copy of `stdinOpen` dies with the process that launched the session, and there
 * was no way to recover it. This is that remainder: the worker actually holds the child's
 * stdin, so a `probe_session` answer it gives can be trusted board-side, and the round trip
 * (parse on the worker, spawn tracking, the wire back) is exactly the kind of change a
 * hand-written protocol addition most easily gets wrong — worth proving against a real daemon
 * rather than a mock.
 *
 * A board restart is simulated the way #745's readoption actually does it: a FRESH
 * `createRemoteAgentService` instance (the old one's in-memory map is gone) adopts the
 * session id onto the SAME worker connection, exactly as `remote-session-readoption.ts` does
 * at boot.
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
import { createRemoteAgentService } from "../services/agent-remote.service.js";
import { startWorkerDaemon, type WorkerDaemonHandle } from "../worker/worker-daemon.js";
import type { AgentOutputEvent } from "../services/agent.service.js";
import type { Database } from "../db/index.js";

const hostStub = new Proxy({}, {
  get: (_t, prop) => () => {
    throw new Error(`host implementation must not be used in this test (called ${String(prop)})`);
  },
}) as AgentExecutionService;

describe("remote turn-state recovery e2e (#900)", () => {
  let db: Database;
  let fleet: WorkerFleet;
  let server: ReturnType<typeof serve>;
  let boardUrl: string;
  let daemon: WorkerDaemonHandle;
  let dispatch: AgentExecutionService;
  const fixtureDir = mkdtempSync(join(tmpdir(), "ak-worker-stdin-recovery-e2e-"));
  const stateFile = join(fixtureDir, `worker-state-${randomUUID()}.json`);
  // Accumulates every byte received on stdin and only echoes + exits once stdin CLOSES —
  // so a multi-turn session (initial prompt, then a follow-up write) proves both pieces of
  // data actually reached the real child process, not just that a WS send() returned true.
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

    const { pairingToken } = fleet.registry.mintPairingToken();
    daemon = await startWorkerDaemon({
      boardUrl, pairingToken, name: "stdin-recovery-e2e-worker", providers: ["claude"], stateFile,
      maxConcurrency: 2, log: () => {},
      workRoot: mkdtempSync(join(tmpdir(), "ak-worker-root-")),
    });
    await daemon.connected;
  });

  afterAll(async () => {
    await daemon.stop({ killAgents: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("recovers stdin state from the worker and delivers a follow-up turn to the real process", async () => {
    const sessionId = `sess-${randomUUID()}`;
    const events1: AgentOutputEvent[] = [];
    // keepAlive holds stdin open — the fixture never sees EOF from the initial prompt alone.
    dispatch.launch({
      worktreePath: tmpdir(), sessionId, prompt: "first-turn", agentArgs: undefined,
      onOutput: (e) => events1.push(e), agentCommand: `node ${scriptPath}`, keepAlive: true,
      placement: { kind: "remote", workerId: daemon.workerId },
    });

    // "Board restart": a brand-new service instance knows NOTHING about sessionId's
    // stdin — the exact state adoptSession's default reflects for real (#745/#874).
    const restarted = createRemoteAgentService(fleet.connections, db);
    const events2: AgentOutputEvent[] = [];
    restarted.adoptSession({ sessionId, workerId: daemon.workerId, onOutput: (e) => events2.push(e) });
    const dispatchAfterRestart = createAgentDispatch({ host: hostStub, remote: restarted });

    // Pins the pre-#900 bug: the board's own copy of stdinOpen defaults to false.
    expect(dispatchAfterRestart.isStdinOpen(sessionId)).toBe(false);
    expect(dispatchAfterRestart.sendInput(sessionId, "premature")).toBe(false);

    // #900: ask the REAL worker daemon. It actually holds the child's stdin.
    const outcome = await restarted.probeStdinIdle(sessionId);
    expect(outcome).toEqual({ ok: true, stdinOpen: true });
    expect(dispatchAfterRestart.isStdinOpen(sessionId)).toBe(true);

    // The recovered state actually lets a follow-up turn through.
    expect(
      dispatchAfterRestart.sendInput(sessionId, JSON.stringify({ type: "user", content: "second-turn" })),
    ).toBe(true);
    expect(dispatchAfterRestart.closeStdin(sessionId)).toBe(true);

    await vi.waitFor(() => expect(events2.some((e) => e.type === "exit")).toBe(true), { timeout: 20000 });
    const stdout = events2.filter((e) => e.type === "stdout").map((e) => e.data).join("");
    // Both turns landed on the ONE real process — proof this was not a WS send() that
    // silently went nowhere.
    expect(stdout).toContain("first-turn");
    expect(stdout).toContain("second-turn");
    const exit = events2.find((e) => e.type === "exit");
    expect(exit?.exitCode).toBe(0);
  }, 30000);

  it("does not read an already-exited session's silence as an open stdin", async () => {
    const sessionId = `sess-${randomUUID()}`;
    const events: AgentOutputEvent[] = [];
    // No keepAlive: the launch closes stdin immediately, so the fixture exits right away.
    dispatch.launch({
      worktreePath: tmpdir(), sessionId, prompt: "one-shot", agentArgs: undefined,
      onOutput: (e) => events.push(e), agentCommand: `node ${scriptPath}`, keepAlive: false,
      placement: { kind: "remote", workerId: daemon.workerId },
    });
    await vi.waitFor(() => expect(events.some((e) => e.type === "exit")).toBe(true), { timeout: 20000 });

    const restarted = createRemoteAgentService(fleet.connections, db);
    restarted.adoptSession({ sessionId, workerId: daemon.workerId, onOutput: () => {} });

    const outcome = await restarted.probeStdinIdle(sessionId);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toMatch(/exited, not running/);
  }, 30000);
}, 90000);
