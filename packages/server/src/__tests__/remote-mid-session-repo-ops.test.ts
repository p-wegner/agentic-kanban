// @covers fleet.remote.mid-session-repo-ops [fleet, git]
/**
 * #783 / #784 END TO END: a REAL worker daemon, a REAL git smart-HTTP transport, and a
 * session that is still RUNNING while the board reaches into the worker's checkout.
 *
 * The two defects this proves are fixed, both of which made remote dispatch second-class:
 *
 *  - #783 nothing ever pushed BOARD-side commits into the worker's checkout, so a second
 *    `/turn` ran against the tree the session cloned. Here the board commits on the branch
 *    mid-session and the worker's live checkout is observed to CONTAIN that commit
 *    afterwards — which is the "second turn runs against a tree containing it" the ticket
 *    asks for, checked at the checkout rather than inferred from a message.
 *  - #784 the board's worktree stayed at the base tip for the whole run, so `GET /diff`
 *    showed nothing until exit. Here the agent commits mid-run, the board asks for the
 *    push, lands it fast-forward-only, and the branch carries the work WHILE the session
 *    is still alive.
 *
 * And the refusals, which matter more than the happy paths: a diverged worker checkout is
 * HELD with its HEAD untouched, never reset, never forced.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { projects } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import { createWorkersRoute } from "../routes/workers.js";
import { createWorkerWsRoute } from "../services/worker-connection.service.js";
import { getWorkerFleet, type WorkerFleet } from "../services/worker-fleet.service.js";
import { createAgentDispatch, type AgentExecutionService } from "../services/agent-dispatch.service.js";
import { startWorkerDaemon, type WorkerDaemonHandle } from "../worker/worker-daemon.js";
import { startGitHttpServer, type GitHttpHandle } from "../services/git-http.service.js";
import {
  landRemoteMidSessionWork,
  type ProbeLiveness,
  type RemoteRepoOpPort,
} from "../services/worker-remote-sync.service.js";
import type { RemoteAgentService } from "../services/agent-remote.service.js";
import type { AgentOutputEvent } from "../services/agent.service.js";

const PROJECT_ID = "77770000-1111-2222-3333-444455556666";

const hostStub = new Proxy({}, {
  get: (_t, prop) => () => { throw new Error(`host must not be used (called ${String(prop)})`); },
}) as AgentExecutionService;

/** Alive, without needing the registry's heartbeat clock: the socket IS the evidence here. */
const alive: ProbeLiveness = async () => ({ liveness: "alive", reason: "worker socket is held" });

describe("mid-session repo operations against a live remote worker (#783, #784)", () => {
  let db: Database;
  let fleet: WorkerFleet;
  let remote: RemoteAgentService;
  let git: GitHttpHandle;
  let server: ReturnType<typeof serve>;
  let boardUrl: string;
  let daemon: WorkerDaemonHandle;
  let dispatch: AgentExecutionService;
  let repoDir: string;
  let workerRoot: string;
  let controlDir: string;
  const stateFile = join(tmpdir(), `mid-session-${randomUUID()}.json`);
  const agentScript = join(tmpdir(), `mock-agent-live-${randomUUID()}.cjs`);

  beforeAll(async () => {
    db = createTestDb().db as unknown as Database;
    fleet = getWorkerFleet(db);
    remote = fleet.remoteAgentService as RemoteAgentService;
    dispatch = createAgentDispatch({ host: hostStub, remote: fleet.remoteAgentService });

    repoDir = mkdtempSync(join(tmpdir(), "mid-session-board-"));
    workerRoot = mkdtempSync(join(tmpdir(), "mid-session-worker-"));
    controlDir = mkdtempSync(join(tmpdir(), "mid-session-control-"));

    await gitExecOrThrow(["init", "-b", "master", repoDir], {});
    await gitExecOrThrow(["config", "user.email", "board@test"], { cwd: repoDir });
    await gitExecOrThrow(["config", "user.name", "Board"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "board repo\n");
    await gitExecOrThrow(["add", "."], { cwd: repoDir });
    await gitExecOrThrow(["commit", "-m", "init"], { cwd: repoDir });

    await db.insert(projects).values({
      id: PROJECT_ID,
      name: "mid-session-fixture",
      repoPath: repoDir,
      defaultBranch: "master",
    } as typeof projects.$inferInsert);

    // A LONG-LIVED "agent": it prints its cwd, then polls a control directory. `commit`
    // makes it commit a file; `exit` ends it. That is what lets the test act on a session
    // that is genuinely still running, which is the whole subject here.
    writeFileSync(
      agentScript,
      `const fs = require("fs");
       const path = require("path");
       const { execFileSync } = require("child_process");
       const control = process.argv[2];
       const g = (...a) => execFileSync("git", a, { stdio: "pipe" });
       g("config", "user.email", "worker@test"); g("config", "user.name", "Worker");
       console.log("AGENT-CWD:" + process.cwd());
       let n = 0;
       const tick = () => {
         if (fs.existsSync(path.join(control, "exit"))) { console.log("AGENT-EXIT"); process.exit(0); }
         const flag = path.join(control, "commit" + (n + 1));
         if (fs.existsSync(flag)) {
           n += 1;
           fs.writeFileSync("agent-work-" + n + ".txt", "agent commit " + n + "\\n");
           g("add", "."); g("commit", "-m", "agent commit " + n);
           console.log("AGENT-COMMITTED:" + n);
         }
         setTimeout(tick, 150);
       };
       tick();`,
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
    git = await startGitHttpServer({ database: db, host: "127.0.0.1" });

    const { pairingToken } = fleet.registry.mintPairingToken();
    // No shares-filesystem label => a TRUE remote worker with its own checkout.
    daemon = await startWorkerDaemon({
      boardUrl, pairingToken, name: "mid-session-worker", providers: ["claude"],
      stateFile, workRoot: workerRoot, log: () => {}, maxConcurrency: 4,
    });
    await daemon.connected;
  }, 120000);

  afterAll(async () => {
    // `stop()` is ASYNC and DRAINS (#754). Unawaited it both races the teardown below and
    // leaves its promise unhandled, so a rejection in shutdown is reported against whatever
    // file vitest runs NEXT — the cross-file misattribution of #680 (#777, #816).
    await daemon?.stop({ killAgents: true });
    await git?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    for (const p of [repoDir, workerRoot, controlDir]) rmSync(p, { recursive: true, force: true });
    for (const f of [stateFile, agentScript]) rmSync(f, { force: true });
  });

  /** Start a live remote session on `branch`; resolves once the agent has reported its cwd. */
  async function startLiveSession(branch: string, control: string): Promise<{
    sessionId: string;
    events: AgentOutputEvent[];
    checkout: string;
  }> {
    const sessionId = `sess-${randomUUID()}`;
    const events: AgentOutputEvent[] = [];
    dispatch.launch({
      worktreePath: join(repoDir, ".worktrees", "unused"),
      sessionId,
      prompt: "work the ticket",
      agentArgs: undefined,
      onOutput: (e) => events.push(e),
      agentCommand: `node ${agentScript} ${control}`,
      keepAlive: false,
      placement: {
        kind: "remote",
        workerId: daemon.workerId,
        repo: { projectId: PROJECT_ID, repoPath: repoDir, branch, baseBranch: "master" },
      },
    });
    await vi.waitFor(
      () => expect(events.some((e) => e.type === "stdout" && (e.data ?? "").includes("AGENT-CWD:"))).toBe(true),
      { timeout: 90000, interval: 200 },
    );
    return { sessionId, events, checkout: join(workerRoot, "checkouts", sessionId) };
  }

  function stdoutOf(events: AgentOutputEvent[]): string {
    return events.filter((e) => e.type === "stdout").map((e) => e.data).join("");
  }

  it("#783: a BOARD commit made between turns reaches the worker's live checkout", async () => {
    const branch = "feature/ak-783-sync";
    const control = join(controlDir, "sync");
    mkdirSync(control, { recursive: true });
    const { sessionId, events, checkout } = await startLiveSession(branch, control);
    try {
      // The worker cloned; its checkout has no knowledge of what the board does next.
      expect(existsSync(join(checkout, "board-fix.txt"))).toBe(false);

      // The board commits on the session's branch — exactly what `update-base`, a
      // fix-and-merge change or a landed review fix leave behind, and what a second turn
      // used to silently rebuild without.
      // Exactly what `POST /api/workspaces` does: carve the worktree and attach the
      // feature branch. The board holds the branch; the worker holds a clone of it.
      const boardWorktree = join(repoDir, ".worktrees", "ak-783");
      await gitExecOrThrow(["worktree", "add", "-b", branch, boardWorktree, "master"], { cwd: repoDir });
      writeFileSync(join(boardWorktree, "board-fix.txt"), "a fix that only exists board-side\n");
      await gitExecOrThrow(["config", "user.email", "board@test"], { cwd: boardWorktree });
      await gitExecOrThrow(["config", "user.name", "Board"], { cwd: boardWorktree });
      await gitExecOrThrow(["add", "."], { cwd: boardWorktree });
      await gitExecOrThrow(["commit", "-m", "board-side fix between turns"], { cwd: boardWorktree });
      const boardSha = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: boardWorktree })).trim();

      // What a follow-up turn now does first.
      const outcome = await remote.requestRepoOp(sessionId, "sync", { timeoutMs: 60000 });

      expect(outcome).toMatchObject({ ok: true });
      expect(outcome.ok && outcome.sha).toBe(boardSha);
      // The observable claim: the tree the next turn runs in contains the board's commit.
      expect(existsSync(join(checkout, "board-fix.txt"))).toBe(true);
      const headSubject = await gitExecOrThrow(["log", "-1", "--format=%s"], { cwd: checkout });
      expect(headSubject.trim()).toBe("board-side fix between turns");

      // Asking again is a no-op, not a second fast-forward.
      const again = await remote.requestRepoOp(sessionId, "sync", { timeoutMs: 60000 });
      expect(again).toMatchObject({ ok: true, status: "unchanged" });
    } finally {
      writeFileSync(join(control, "exit"), "");
      await vi.waitFor(() => expect(events.some((e) => e.type === "exit")).toBe(true), { timeout: 60000 });
    }
  }, 240000);

  it("#784: a diff mid-run sees the agent's committed work, landed fast-forward-only", async () => {
    const branch = "feature/ak-784-diff";
    const control = join(controlDir, "diff");
    mkdirSync(control, { recursive: true });
    const { sessionId, events, checkout } = await startLiveSession(branch, control);
    try {
      // Before the agent commits anything the board has no such branch content at all.
      writeFileSync(join(control, "commit1"), "");
      await vi.waitFor(() => expect(stdoutOf(events)).toContain("AGENT-COMMITTED:1"), { timeout: 60000, interval: 200 });

      const ops = remote as unknown as RemoteRepoOpPort;
      const landing = await landRemoteMidSessionWork({
        session: { id: sessionId, workerId: daemon.workerId, startedAt: new Date().toISOString() },
        ops,
        probeLiveness: alive,
        timeoutMs: 60000,
      });

      expect(landing).not.toBeNull();
      expect(landing!.landed).toBe(true);
      // The session is STILL RUNNING — that is what was impossible before.
      expect(events.some((e) => e.type === "exit")).toBe(false);
      const workerHead = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: checkout })).trim();
      const boardBranch = (await gitExecOrThrow(["rev-parse", `refs/heads/${branch}`], { cwd: repoDir })).trim();
      expect(boardBranch).toBe(workerHead);
      const file = await gitExecOrThrow(["show", `refs/heads/${branch}:agent-work-1.txt`], { cwd: repoDir });
      expect(file).toContain("agent commit 1");
      // The staging ref is cleared once landed, so it never means anything but "not yet landed".
      const incoming = await gitExec(["rev-parse", "--verify", `refs/kanban/incoming/${branch}`], { cwd: repoDir });
      expect(incoming.code).not.toBe(0);
      // And it says how fresh it is, rather than presenting an unknown age as current.
      expect(typeof landing!.ageMs).toBe("number");

      // A SECOND mid-run commit lands on top by fast-forward, still mid-session.
      writeFileSync(join(control, "commit2"), "");
      await vi.waitFor(() => expect(stdoutOf(events)).toContain("AGENT-COMMITTED:2"), { timeout: 60000, interval: 200 });
      const second = await landRemoteMidSessionWork({
        session: { id: sessionId, workerId: daemon.workerId, startedAt: new Date().toISOString() },
        ops,
        probeLiveness: alive,
        timeoutMs: 60000,
      });
      expect(second!.landed).toBe(true);
      const count = await gitExecOrThrow(["rev-list", "--count", `refs/heads/${branch}`], { cwd: repoDir });
      expect(Number(count.trim())).toBe(3); // init + agent commit 1 + agent commit 2
    } finally {
      writeFileSync(join(control, "exit"), "");
      await vi.waitFor(() => expect(events.some((e) => e.type === "exit")).toBe(true), { timeout: 60000 });
    }
  }, 240000);

  it("a DIVERGED worker checkout is held and reported — its HEAD is not reset", async () => {
    const branch = "feature/ak-783-diverged";
    const control = join(controlDir, "diverged");
    mkdirSync(control, { recursive: true });
    const { sessionId, events, checkout } = await startLiveSession(branch, control);
    try {
      // Both sides commit independently: the agent in its checkout...
      writeFileSync(join(control, "commit1"), "");
      await vi.waitFor(() => expect(stdoutOf(events)).toContain("AGENT-COMMITTED:1"), { timeout: 60000, interval: 200 });
      const workerHeadBefore = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: checkout })).trim();

      // ...and the board on the same branch, from the base.
      const boardWorktree = join(repoDir, ".worktrees", "ak-783-div");
      await gitExecOrThrow(["worktree", "add", "-b", branch, boardWorktree, "master"], { cwd: repoDir });
      await gitExecOrThrow(["config", "user.email", "board@test"], { cwd: boardWorktree });
      await gitExecOrThrow(["config", "user.name", "Board"], { cwd: boardWorktree });
      writeFileSync(join(boardWorktree, "board-only.txt"), "board-side only\n");
      await gitExecOrThrow(["add", "."], { cwd: boardWorktree });
      await gitExecOrThrow(["commit", "-m", "board-side divergent commit"], { cwd: boardWorktree });

      const outcome = await remote.requestRepoOp(sessionId, "sync", { timeoutMs: 60000 });

      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.status).toBe("diverged");
      // Nothing was destroyed: the agent's commit is still the checkout's HEAD, and the
      // board's file was NOT dragged in by a reset or a force.
      expect((await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: checkout })).trim()).toBe(workerHeadBefore);
      expect(existsSync(join(checkout, "agent-work-1.txt"))).toBe(true);
      expect(existsSync(join(checkout, "board-only.txt"))).toBe(false);
    } finally {
      writeFileSync(join(control, "exit"), "");
      await vi.waitFor(() => expect(events.some((e) => e.type === "exit")).toBe(true), { timeout: 60000 });
    }
  }, 240000);
});
