// #754 — the fleet daemon is a long-running process on someone ELSE'S machine, so each of
// these was a data-loss or silent-stall bug rather than a rough edge:
//
//   1. Ctrl+C stranded completed work: `stop()` was sync and the CLI called
//      `process.exit(0)` right after, so with the agents killed the process was gone
//      before their exit handlers could push the results back.
//   2. There was no drain at all, and `draining` — a declared status honoured by
//      `eligibleWorkers` and coloured by the panel — had no writer anywhere.
//   3. An EPIPE on an agent's stdin killed the daemon and orphaned every other session.
//   4. A 401 was indistinguishable from network loss, so a revoked worker reconnected
//      every 30 s forever while the pairing file blocked the documented recovery.
//   5. Capabilities travelled only at first registration, so board and worker silently
//      disagreed about the same machine after a re-run with new flags.
//   6. There was no version handshake, so board/worker skew failed as a silence.
//
// These drive the real daemon against a FAKE BOARD (a Hono app + ws on a real port), which
// is the seam where every one of them is observable: what the daemon sends, what it does
// with a 401/409, and what `stop()` waits for.

import { describe, it, expect, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WORKER_PROTOCOL_VERSION } from "@agentic-kanban/shared/lib/worker-protocol";
import type { WorkerLaunchSpec, WorkerRepoTransport, WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import { createWorkerAgentRunner } from "../worker/worker-agent-runner.js";
import { MAX_REPAIR_ATTEMPTS, startWorkerDaemon, type WorkerDaemonHandle } from "../worker/worker-daemon.js";

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined),
) as Record<string, string>;

function nodeSpec(script: string, overrides?: Partial<WorkerLaunchSpec>): WorkerLaunchSpec {
  return {
    command: process.execPath,
    args: ["-e", script],
    env: cleanEnv,
    cwd: tmpdir(),
    stdinPrompt: "",
    hangTimeoutMs: 0,
    ...overrides,
  };
}

const fakeRepo = (branch: string): WorkerRepoTransport => ({
  projectId: "p1",
  gitPort: 1,
  gitToken: "t",
  branch,
  baseBranch: "master",
  incomingRef: `refs/kanban/incoming/${branch}`,
});

/**
 * A git transport that does no git. The behaviour under test is what a SHUTDOWN does about
 * a push, so the push is the thing that has to be controllable — a real one can be made
 * neither to hang on demand nor to finish on demand, and a real provision needs a live
 * git-HTTP listener and a repo just to reach the code under test.
 */
function stubRepoOps(push: () => Promise<void>) {
  return {
    provision: async () => ({ cwd: tmpdir(), cacheDir: tmpdir() }),
    push,
    cleanup: async () => {},
  };
}

/**
 * A board that records what the daemon told it. Only the three worker-facing endpoints,
 * hand-rolled rather than mounted from routes/workers.ts, so a test can answer 401/409 on
 * demand — which is exactly what the real board does and what the daemon never handled.
 */
interface FakeBoard {
  url: string;
  registrations: Array<Record<string, unknown>>;
  heartbeats: Array<Record<string, unknown>>;
  hellos: Array<Record<string, unknown>>;
  /** Set to 401/409 to make every AUTHENTICATED call fail that way. */
  authStatus: number;
  /** Set to 409 to make registration itself be refused. */
  registerStatus: number;
  close(): Promise<void>;
}

async function startFakeBoard(): Promise<FakeBoard> {
  const state = {
    registrations: [] as Array<Record<string, unknown>>,
    heartbeats: [] as Array<Record<string, unknown>>,
    hellos: [] as Array<Record<string, unknown>>,
    authStatus: 200,
    registerStatus: 201,
  };
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.post("/api/workers/register", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    state.registrations.push(body);
    if (state.registerStatus !== 201) {
      return c.json(
        { error: "incompatible worker protocol: test refusal", boardProtocolVersion: 99 },
        state.registerStatus as 409,
      );
    }
    return c.json({ workerId: "w-fake", workerToken: `tok-${state.registrations.length}` }, 201);
  });

  app.post("/api/workers/:id/heartbeat", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    state.heartbeats.push(body);
    if (state.authStatus !== 200) {
      return c.json({ error: "nope", boardProtocolVersion: 99 }, state.authStatus as 401);
    }
    return c.json({ ok: true });
  });

  // Registered BEFORE the route, or Hono matches the handler first and this never runs.
  // The real board refuses the upgrade the same way: pre-upgrade, with a status — which is
  // what the client sees as `unexpected-response`, and what used to be swallowed entirely.
  app.use("/ws/workers/:id", async (c, next) => {
    if (state.authStatus !== 200) return c.json({ error: "nope" }, state.authStatus as 401);
    return next();
  });
  app.get(
    "/ws/workers/:id",
    upgradeWebSocket(() => ({
      onMessage(event) {
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (parsed.type === "hello") state.hellos.push(parsed);
        } catch { /* not our business here */ }
      },
    })),
  );

  const { port, server } = await new Promise<{ port: number; server: ReturnType<typeof serve> }>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      resolve({ port: info.port, server: s });
    });
  });
  injectWebSocket(server);

  return {
    url: `http://127.0.0.1:${port}`,
    get registrations() { return state.registrations; },
    get heartbeats() { return state.heartbeats; },
    get hellos() { return state.hellos; },
    get authStatus() { return state.authStatus; },
    set authStatus(v: number) { state.authStatus = v; },
    get registerStatus() { return state.registerStatus; },
    set registerStatus(v: number) { state.registerStatus = v; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("the drain waits for results that are already finished (#754 items 1+2)", () => {
  it("stop() waits for an in-flight push and reports it as saved", async () => {
    let release!: () => void;
    let pushReached = false;
    const runner = createWorkerAgentRunner(() => {}, {
      boardUrl: "http://board",
      repoOps: stubRepoOps(() => {
        pushReached = true;
        return new Promise<void>((r) => { release = r; });
      }),
    });
    // A git-transport session that has finished: the runner owes the board a push.
    runner.assignWithRepo("s-push", nodeSpec("process.exit(0)"), fakeRepo("feature/ak-1"));
    await vi.waitFor(() => expect(runner.pendingPushCount()).toBe(1), { timeout: 20000 });
    expect(pushReached).toBe(true);

    const drain = runner.drainPushes(20000);
    release();
    // The original bug: nothing held a reference to this push, so `stop()` +
    // `process.exit(0)` killed the process mid-push and the board learned about a
    // completed agent as a 60 s-grace failure.
    expect(await drain).toEqual({ completed: 1, abandoned: 0 });
  }, 40000);

  it("gives up on a push that outlives the timeout, and SAYS it abandoned it", async () => {
    const runner = createWorkerAgentRunner(() => {}, {
      boardUrl: "http://board",
      // Never resolves: a real one is a `git push` over a link that may be gone, which is
      // exactly why the wait has to be bounded rather than infinite.
      repoOps: stubRepoOps(() => new Promise<void>(() => {})),
    });
    runner.assignWithRepo("s-hang", nodeSpec("process.exit(0)"), fakeRepo("feature/ak-2"));
    await vi.waitFor(() => expect(runner.pendingPushCount()).toBe(1), { timeout: 20000 });
    // `abandoned` is the number that matters: reporting success here would be the original
    // bug wearing a drain's clothes.
    expect(await runner.drainPushes(150)).toEqual({ completed: 0, abandoned: 1 });
  }, 40000);

  it("a session with no repo owes no push, so a drain is instant and empty", async () => {
    const runner = createWorkerAgentRunner(() => {}, {});
    runner.assign("s-plain", nodeSpec("process.exit(0)"));
    await vi.waitFor(() => expect(runner.runningSessionIds()).toEqual([]), { timeout: 20000 });
    expect(await runner.drainPushes(50)).toEqual({ completed: 0, abandoned: 0 });
  }, 40000);
});

describe("the daemon against a real board socket (#754 items 2,4,5,6)", () => {
  let board: FakeBoard | undefined;
  let daemon: WorkerDaemonHandle | undefined;
  const stateFiles: string[] = [];

  function stateFile(): string {
    const f = join(mkdtempSync(join(tmpdir(), "ak-worker-state-")), "worker-state.json");
    stateFiles.push(f);
    return f;
  }

  afterEach(async () => {
    await daemon?.stop({ killAgents: true, drainTimeoutMs: 100 }).catch(() => {});
    daemon = undefined;
    await board?.close();
    board = undefined;
    for (const f of stateFiles.splice(0)) rmSync(join(f, ".."), { recursive: true, force: true });
  });

  it("declares its protocol, build and capabilities at registration AND on every beat", async () => {
    board = await startFakeBoard();
    daemon = await startWorkerDaemon({
      boardUrl: board.url,
      pairingToken: "pair-1",
      name: "cap-worker",
      labels: ["docker", "linux"],
      providers: ["claude"],
      maxConcurrency: 3,
      stateFile: stateFile(),
      heartbeatIntervalMs: 60,
      log: () => {},
    });
    await daemon.connected;

    // Registration carries the handshake...
    expect(board.registrations).toHaveLength(1);
    expect(board.registrations[0]).toMatchObject({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      labels: ["docker", "linux"],
      providers: ["claude"],
      maxConcurrency: 3,
    });

    // ...and so does `hello`, which is what a RECONNECT re-declares.
    await vi.waitFor(() => expect(board!.hellos.length).toBeGreaterThan(0), { timeout: 10000 });
    expect(board.hellos[0]).toMatchObject({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      capabilities: { labels: ["docker", "linux"], providers: ["claude"], maxConcurrency: 3 },
    });

    // The regression: capabilities used to travel ONLY at first registration, so re-running
    // `start --labels ... --max-concurrency 4` changed nothing on the board.
    await vi.waitFor(() => expect(board!.heartbeats.length).toBeGreaterThan(0), { timeout: 10000 });
    expect(board.heartbeats[0]).toMatchObject({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      capabilities: { labels: ["docker", "linux"], providers: ["claude"], maxConcurrency: 3 },
    });
  }, 30000);

  it("announces `draining` before it stops, so the board can stop assigning", async () => {
    board = await startFakeBoard();
    daemon = await startWorkerDaemon({
      boardUrl: board.url,
      pairingToken: "pair-1",
      stateFile: stateFile(),
      heartbeatIntervalMs: 60_000, // no periodic beat: the drain must send one itself
      log: () => {},
    });
    await daemon.connected;
    expect(board.heartbeats.filter((h) => h.status === "draining")).toHaveLength(0);

    await daemon.drain();
    // `draining` was a status nothing ever wrote — the only way out of rotation was revoke,
    // which also kills in-flight git tokens.
    expect(board.heartbeats.some((h) => h.status === "draining")).toBe(true);

    const report = await daemon.stop({ killAgents: true, drainTimeoutMs: 200 });
    daemon = undefined;
    expect(report).toEqual({
      pushesCompleted: 0,
      pushesAbandoned: 0,
      agentsLeftRunning: 0,
      criticalMessagesLost: 0,
      // #750: nothing was held back either — a retained result would mean work still
      // sitting in a checkout on this machine.
      resultsRetained: 0,
    });
  }, 30000);

  it("stop() also announces draining when nobody called drain() first", async () => {
    board = await startFakeBoard();
    daemon = await startWorkerDaemon({
      boardUrl: board.url,
      pairingToken: "pair-1",
      stateFile: stateFile(),
      heartbeatIntervalMs: 60_000,
      log: () => {},
    });
    await daemon.connected;
    await daemon.stop({ killAgents: true, drainTimeoutMs: 200 });
    daemon = undefined;
    // Announced BEFORE the kill: a board that keeps assigning into a dying daemon produces
    // exactly the launch failures the shutdown is trying to avoid.
    expect(board.heartbeats.some((h) => h.status === "draining")).toBe(true);
  }, 30000);

  it("refuses to start against a board that rejects this build on protocol grounds", async () => {
    board = await startFakeBoard();
    board.registerStatus = 409;
    await expect(
      startWorkerDaemon({
        boardUrl: board.url,
        pairingToken: "pair-1",
        stateFile: stateFile(),
        log: () => {},
      }),
    ).rejects.toThrow(/refuses this worker build/);
  }, 30000);
});

describe("an agent's stdin cannot take the daemon down (#754 item 3)", () => {
  it("survives an EPIPE from an agent that exits before reading its prompt", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      const messages: WorkerToBoardMessage[] = [];
      const runner = createWorkerAgentRunner((m) => messages.push(m), {});
      // Exits immediately; the prompt is far bigger than a pipe buffer, so the write
      // cannot complete and the pipe breaks under it. Before #754 nothing in worker/
      // listened for that 'error' — and an unhandled stream error is a process-level
      // uncaught exception, i.e. the daemon and every other agent on it.
      runner.assign(
        "s-epipe",
        nodeSpec("process.exit(0)", { stdinPrompt: "x".repeat(4 * 1024 * 1024), keepStdinOpen: true }),
      );
      await vi.waitFor(
        () => expect(messages.some((m) => m.type === "event" && m.event.type === "exit")).toBe(true),
        { timeout: 20000 },
      );
      expect(uncaught).toEqual([]);
      // And the daemon is still usable afterwards, which is the actual claim.
      runner.assign("s-after", nodeSpec("console.log('still here')"));
      await vi.waitFor(
        () => expect(messages.some((m) => m.type === "event" && m.event.sessionId === "s-after" && m.event.type === "exit")).toBe(true),
        { timeout: 20000 },
      );
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  }, 40000);
});

/**
 * A board that answers 401 to everything except (optionally) registration.
 *
 * Bare `node:http` rather than the Hono fake board above, because `@hono/node-ws` hooks the
 * server's `upgrade` event directly — a Hono middleware never runs for the WebSocket
 * handshake, so a Hono board CANNOT refuse an upgrade, which is exactly the path under test.
 */
function startRejectingBoard(opts: { acceptRegistration: boolean }): Promise<{
  url: string;
  registrations: number;
  close(): Promise<void>;
}> {
  const state = { registrations: 0 };
  const server: Server = createServer((req, res) => {
    if (opts.acceptRegistration && req.url === "/api/workers/register") {
      state.registrations += 1;
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ workerId: "w-repaired", workerToken: `tok-${state.registrations}` }));
      return;
    }
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        get registrations() { return state.registrations; },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe("a 401 stops instead of looping forever (#754 item 4)", () => {
  const dirs: string[] = [];

  /** A state file that already holds a pairing, so no registration is attempted. */
  function pairedStateFile(boardUrl: string): string {
    const dir = mkdtempSync(join(tmpdir(), "ak-worker-paired-"));
    dirs.push(dir);
    const file = join(dir, "worker-state.json");
    writeFileSync(file, JSON.stringify({
      boards: { [boardUrl]: { workerId: `w-${randomUUID()}`, workerToken: "stale-token", name: "paired-box" } },
    }));
    return file;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("with no --token: one fatal error naming the recovery, and no retry loop", async () => {
    const board = await startRejectingBoard({ acceptRegistration: false });
    try {
      const fatal: string[] = [];
      const daemon = await startWorkerDaemon({
        boardUrl: board.url,
        stateFile: pairedStateFile(board.url), // already paired => no --token needed to start
        heartbeatIntervalMs: 40,
        log: () => {},
        onFatal: (reason) => fatal.push(reason),
      });
      await vi.waitFor(() => expect(fatal.length).toBeGreaterThan(0), { timeout: 20000 });
      // The message has to carry the remedy: the old behaviour was a red tray, a 30 s retry
      // loop, and a pairing file that blocked the documented "revoke and re-pair" advice.
      expect(fatal[0]).toMatch(/401/);
      expect(fatal[0]).toMatch(/worker pair/);
      expect(fatal[0]).toMatch(/--token/);
      // Fatal means fatal: no second callback, and no further reconnects behind it.
      await new Promise((r) => setTimeout(r, 300));
      expect(fatal).toHaveLength(1);
      expect(board.registrations).toBe(0);
      await daemon.stop({ killAgents: true, drainTimeoutMs: 50 }).catch(() => {});
    } finally {
      await board.close();
    }
  }, 40000);

  it("with a --token: re-pairs, then gives up rather than re-pairing forever", async () => {
    // This board hands out a token and then rejects it — the shape that turned an unbounded
    // "re-register on 401" into 940 registrations in two minutes while the test watched.
    const board = await startRejectingBoard({ acceptRegistration: true });
    try {
      const fatal: string[] = [];
      const daemon = await startWorkerDaemon({
        boardUrl: board.url,
        pairingToken: "pair-1",
        stateFile: pairedStateFile(board.url),
        heartbeatIntervalMs: 40,
        log: () => {},
        onFatal: (reason) => fatal.push(reason),
      });
      // It DOES attempt the recovery the runbook describes...
      await vi.waitFor(() => expect(board.registrations).toBeGreaterThan(0), { timeout: 20000 });
      // ...and then stops, because a single-use pairing token cannot fix a board that keeps
      // refusing us.
      await vi.waitFor(() => expect(fatal.length).toBe(1), { timeout: 20000 });
      expect(fatal[0]).toMatch(/re-pairing attempt/);
      expect(board.registrations).toBeLessThanOrEqual(MAX_REPAIR_ATTEMPTS);
      await new Promise((r) => setTimeout(r, 300));
      expect(board.registrations).toBeLessThanOrEqual(MAX_REPAIR_ATTEMPTS);
      await daemon.stop({ killAgents: true, drainTimeoutMs: 50 }).catch(() => {});
    } finally {
      await board.close();
    }
  }, 40000);
});
