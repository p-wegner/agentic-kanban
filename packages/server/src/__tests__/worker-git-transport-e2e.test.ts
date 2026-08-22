// Phase 2 end-to-end (#188): a TRUE remote worker — no shared filesystem with
// the board. The worker clones the project over the board's git smart-HTTP
// listener into its own work root, runs the agent there, pushes to the
// incoming ref, and the board fast-forwards the real branch so the normal
// diff/review/merge machinery can act on it.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
import { incomingRefFor } from "../services/worker-remote-sync.service.js";
import type { AgentOutputEvent } from "../services/agent.service.js";

const PROJECT_ID = "bbbbcccc-dddd-eeee-ffff-000011112222";
const BRANCH = "feature/ak-777-remote";

const hostStub = new Proxy({}, {
  get: (_t, prop) => () => { throw new Error(`host must not be used (called ${String(prop)})`); },
}) as AgentExecutionService;

describe("worker git transport e2e (phase 2)", () => {
  let db: Database;
  let fleet: WorkerFleet;
  let git: GitHttpHandle;
  let server: ReturnType<typeof serve>;
  let boardUrl: string;
  let daemon: WorkerDaemonHandle;
  let dispatch: AgentExecutionService;
  let repoDir: string;
  let workerRoot: string;
  const stateFile = join(tmpdir(), `git-transport-${randomUUID()}.json`);
  const agentScript = join(tmpdir(), `mock-agent-git-${randomUUID()}.cjs`);

  beforeAll(async () => {
    db = createTestDb().db as unknown as Database;
    fleet = getWorkerFleet(db);
    dispatch = createAgentDispatch({ host: hostStub, remote: fleet.remoteAgentService });

    repoDir = mkdtempSync(join(tmpdir(), "fleet-board-repo-"));
    workerRoot = mkdtempSync(join(tmpdir(), "fleet-worker-root-"));

    await gitExecOrThrow(["init", "-b", "master", repoDir], {});
    writeFileSync(join(repoDir, "README.md"), "board repo\n");
    await gitExecOrThrow(["add", "."], { cwd: repoDir });
    await gitExecOrThrow(["commit", "-m", "init"], { cwd: repoDir });

    await db.insert(projects).values({
      id: PROJECT_ID,
      name: "fleet-git-fixture",
      repoPath: repoDir,
      defaultBranch: "master",
    } as typeof projects.$inferInsert);

    // The "agent": commits a file in whatever checkout it is launched in, and
    // configures identity so the commit works in a fresh worker worktree.
    writeFileSync(
      agentScript,
      `const { execFileSync } = require("child_process");
       const fs = require("fs");
       fs.writeFileSync("worker-output.txt", "written by the remote worker\\n");
       const g = (...a) => execFileSync("git", a, { stdio: "pipe" });
       // Kept explicit (#285 moved the rest of the suite's identity to env): this script runs
       // in a process the BOARD launches with its own environment, so it cannot rely on the
       // vitest worker's env reaching it.
       g("config", "user.email", "worker@test"); g("config", "user.name", "Worker");
       g("add", "."); g("commit", "-m", "agent work from remote worker");
       console.log("AGENT-DONE:" + process.cwd());`,
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
    // NO shares-filesystem label => a true remote worker.
    daemon = await startWorkerDaemon({
      boardUrl, pairingToken, name: "remote-worker", providers: ["claude"],
      stateFile, workRoot: workerRoot, log: () => {},
    });
    await daemon.connected;
  });

  afterAll(async () => {
    daemon?.stop({ killAgents: true });
    await git?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const p of [repoDir, workerRoot]) rmSync(p, { recursive: true, force: true });
    for (const f of [stateFile, agentScript]) rmSync(f, { force: true });
  });

  it("clones, runs, pushes back, and the board lands the branch", async () => {
    const sessionId = `sess-${randomUUID()}`;
    const events: AgentOutputEvent[] = [];
    dispatch.launch({
      // The board-side cwd is irrelevant for a git-transport session — the
      // worker replaces it with its own checkout path.
      worktreePath: join(repoDir, ".worktrees", "unused"),
      sessionId,
      prompt: "do the remote ticket",
      agentArgs: undefined,
      onOutput: (e) => events.push(e),
      agentCommand: `node ${agentScript}`,
      keepAlive: false,
      placement: {
        kind: "remote",
        workerId: daemon.workerId,
        repo: { projectId: PROJECT_ID, repoPath: repoDir, branch: BRANCH, baseBranch: "master" },
      },
    });

    await vi.waitFor(() => expect(events.some((e) => e.type === "exit")).toBe(true), { timeout: 60000 });

    const stderr = events.filter((e) => e.type === "stderr").map((e) => e.data).join("");
    expect(stderr).not.toContain("could not");
    expect(events.find((e) => e.type === "exit")!.exitCode).toBe(0);
    const stdout = events.filter((e) => e.type === "stdout").map((e) => e.data).join("");
    expect(stdout).toContain("AGENT-DONE:");
    // The agent ran in the WORKER's checkout, not in the board's repo.
    expect(stdout).not.toContain(repoDir.replace(/\\/g, "/").slice(0, 20) + "\n");
    expect(existsSync(join(repoDir, "worker-output.txt"))).toBe(false);

    // The board now has the real branch, fast-forwarded from the incoming ref.
    const branchSha = await gitExec(["rev-parse", "--verify", `refs/heads/${BRANCH}`], { cwd: repoDir });
    expect(branchSha.code).toBe(0);
    const subject = await gitExecOrThrow(["log", "-1", "--format=%s", `refs/heads/${BRANCH}`], { cwd: repoDir });
    expect(subject.trim()).toBe("agent work from remote worker");
    const fileAtBranch = await gitExecOrThrow(["show", `refs/heads/${BRANCH}:worker-output.txt`], { cwd: repoDir });
    expect(fileAtBranch).toContain("written by the remote worker");

    // The staging ref is cleared once its content has landed.
    const incoming = await gitExec(["rev-parse", "--verify", incomingRefFor(BRANCH)], { cwd: repoDir });
    expect(incoming.code).not.toBe(0);

    // The worker's per-session checkout is cleaned up; its repo cache remains.
    expect(existsSync(join(workerRoot, "checkouts", sessionId))).toBe(false);
    expect(existsSync(join(workerRoot, "repos", PROJECT_ID, ".git"))).toBe(true);
  }, 90000);

  it("materializes the branch so a second session resumes from it", async () => {
    const sessionId = `sess-${randomUUID()}`;
    const events: AgentOutputEvent[] = [];
    const secondAgent = join(tmpdir(), `mock-agent-git2-${randomUUID()}.cjs`);
    writeFileSync(
      secondAgent,
      `const fs = require("fs");
       console.log("RESUMED-SEES:" + (fs.existsSync("worker-output.txt") ? "yes" : "no"));`,
    );
    try {
      dispatch.launch({
        worktreePath: repoDir,
        sessionId,
        prompt: "second turn",
        agentArgs: undefined,
        onOutput: (e) => events.push(e),
        agentCommand: `node ${secondAgent}`,
        keepAlive: false,
        placement: {
          kind: "remote",
          workerId: daemon.workerId,
          repo: { projectId: PROJECT_ID, repoPath: repoDir, branch: BRANCH, baseBranch: "master" },
        },
      });
      await vi.waitFor(() => expect(events.some((e) => e.type === "exit")).toBe(true), { timeout: 60000 });
      const stdout = events.filter((e) => e.type === "stdout").map((e) => e.data).join("");
      expect(stdout).toContain("RESUMED-SEES:yes");
    } finally {
      rmSync(secondAgent, { force: true });
    }
  }, 90000);

  // #743 — THE case the two above could not see. They pass a `worktreePath` that is never
  // created, so the branch is checked out nowhere and the ref-only `update-ref` sync works.
  // A real workspace is the opposite: `POST /api/workspaces` carves the worktree (and
  // therefore checks the branch out) before placement is even resolved, and the ref sync is
  // refused for every genuine remote build. Before the fix this test failed with
  // "Worker result could not be landed" and exit 1, and the branch stayed at base.
  it("lands the result even though a REAL board worktree holds the branch", async () => {
    const branch = "feature/ak-743-worktree-held";
    const sessionId = `sess-${randomUUID()}`;
    const worktreePath = join(repoDir, ".worktrees", "ak-743");
    // Exactly what workspace creation does: a worktree with the feature branch attached.
    await gitExecOrThrow(["worktree", "add", "-b", branch, worktreePath, "master"], { cwd: repoDir });
    const baseSha = (await gitExecOrThrow(["rev-parse", `refs/heads/${branch}`], { cwd: repoDir })).trim();

    const agent = join(tmpdir(), `mock-agent-git3-${randomUUID()}.cjs`);
    writeFileSync(
      agent,
      `const { execFileSync } = require("child_process");
       const fs = require("fs");
       fs.writeFileSync("held-branch-output.txt", "landed into a held branch\\n");
       const g = (...a) => execFileSync("git", a, { stdio: "pipe" });
       g("config", "user.email", "worker@test"); g("config", "user.name", "Worker");
       g("add", "."); g("commit", "-m", "work for a branch the board has checked out");
       console.log("AGENT-DONE");`,
    );
    const events: AgentOutputEvent[] = [];
    try {
      dispatch.launch({
        worktreePath,
        sessionId,
        prompt: "do the held-branch ticket",
        agentArgs: undefined,
        onOutput: (e) => events.push(e),
        agentCommand: `node ${agent}`,
        keepAlive: false,
        placement: {
          kind: "remote",
          workerId: daemon.workerId,
          repo: { projectId: PROJECT_ID, repoPath: repoDir, branch, baseBranch: "master" },
        },
      });
      await vi.waitFor(() => expect(events.some((e) => e.type === "exit")).toBe(true), { timeout: 60000 });

      const stderr = events.filter((e) => e.type === "stderr").map((e) => e.data).join("");
      expect(stderr).not.toContain("could not be landed");
      expect(events.find((e) => e.type === "exit")!.exitCode).toBe(0);

      // The REAL branch advanced past the base — so diff/review/merge see the work.
      const tip = (await gitExecOrThrow(["rev-parse", `refs/heads/${branch}`], { cwd: repoDir })).trim();
      expect(tip).not.toBe(baseSha);
      const file = await gitExecOrThrow(["show", `refs/heads/${branch}:held-branch-output.txt`], { cwd: repoDir });
      expect(file).toContain("landed into a held branch");
      // The board worktree that HOLDS the branch was fast-forwarded with it, so its HEAD,
      // index and working tree agree with the branch (a bare `update-ref` would not).
      expect((await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: worktreePath })).trim()).toBe(tip);
      expect(existsSync(join(worktreePath, "held-branch-output.txt"))).toBe(true);
      const status = await gitExecOrThrow(["status", "--porcelain"], { cwd: worktreePath });
      expect(status.trim()).toBe("");
      // The staging ref is cleared once it has landed.
      const incoming = await gitExec(["rev-parse", "--verify", incomingRefFor(branch)], { cwd: repoDir });
      expect(incoming.code).not.toBe(0);
    } finally {
      await gitExec(["worktree", "remove", "--force", worktreePath], { cwd: repoDir });
      rmSync(agent, { force: true });
    }
  }, 90000);
});
