// #1461 - a drain-stop with a result push still in flight used to log "abandoned ... the queue is
// in memory only" and leave nothing on disk. Pinned here: the in-flight push is written to the
// durable undelivered-results store, its checkout survives, the next start delivers it, and
// `worker status` shows the held result and both Node versions.

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerAgentRunner } from "../worker/worker-agent-runner.js";
import { loadUndelivered } from "../worker/worker-undelivered.js";
import { renderStatus } from "../worker/worker-lifecycle.js";
import type { WorkerLaunchSpec, WorkerRepoTransport, WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";

const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>;
const spec: WorkerLaunchSpec = {
  command: process.execPath,
  args: ["-e", "process.exit(0)"],
  env: cleanEnv,
  cwd: tmpdir(),
  stdinPrompt: "",
  hangTimeoutMs: 0,
};
const repo: WorkerRepoTransport = {
  projectId: "p1",
  gitPort: 1,
  gitToken: "t",
  branch: "feature/ak-1461",
  baseBranch: "master",
  incomingRef: "refs/kanban/incoming/feature/ak-1461",
};
const CHECKOUT = mkdtempSync(join(tmpdir(), "ak-worker-checkout-1461-"));

describe("#1461 - drain-stop with a push in flight", () => {
  it("persists the in-flight push, keeps the checkout, and delivers on the next start", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "ak-worker-root-1461-"));
    const sent: WorkerToBoardMessage[] = [];
    let release!: () => void;
    const hung = new Promise<void>((resolve) => { release = resolve; });
    const state = { cleanups: 0 };
    const runner = createWorkerAgentRunner((m) => sent.push(m), {
      boardUrl: "http://board",
      workRoot,
      pushRetryDelaysMs: [],
      repoOps: {
        provision: async () => ({ cwd: CHECKOUT, cacheDir: tmpdir() }),
        push: () => hung,
        cleanup: async () => { state.cleanups += 1; },
      },
    });

    runner.assignWithRepo("s-1461", spec, repo);
    await vi.waitFor(() => expect(runner.pendingPushCount()).toBe(1), { timeout: 20000 });

    const drained = await runner.drainPushes(100, 20);
    expect(drained.abandoned).toBe(1);
    expect(drained.abandonedSessions).toEqual([{ sessionId: "s-1461", branch: "feature/ak-1461" }]);

    // Durable, token-free, and the checkout was not cleaned up.
    const onDisk = loadUndelivered(workRoot);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]).toMatchObject({ sessionId: "s-1461", branch: "feature/ak-1461", checkoutPath: CHECKOUT });
    expect(JSON.stringify(onDisk)).not.toContain('"t"');
    expect(state.cleanups).toBe(0);

    // "Next start": a fresh runner on the same work root restores and delivers it.
    const pushed: string[] = [];
    const next = createWorkerAgentRunner(() => {}, {
      boardUrl: "http://board",
      workRoot,
      repoOps: {
        provision: async () => ({ cwd: CHECKOUT, cacheDir: tmpdir() }),
        push: async () => { pushed.push("delivered"); },
        cleanup: async () => {},
      },
    });
    expect(next.unpushedResults().map((r) => r.sessionId)).toEqual(["s-1461"]);
    const outcome = await next.retryPendingPushes();
    expect(pushed).toEqual(["delivered"]);
    expect(outcome.pushed).toEqual(["s-1461"]);
    expect(loadUndelivered(workRoot)).toEqual([]);

    release(); // let the original hung push settle so nothing dangles
  });

  it("status shows the daemon's and the sessions' Node and the undelivered results", () => {
    const text = renderStatus({
      daemonNode: "v23.7.0",
      sessionsNode: "v24.1.0",
      undelivered: [{ sessionId: "s-1", branch: "feature/ak-9", checkoutPath: "/w/s-1", attempts: 0, lastError: "in flight" }],
    });
    expect(text).toContain("daemon v23.7.0, sessions v24.1.0");
    expect(text).toContain("differ");
    expect(text).toContain("s-1 branch feature/ak-9");
  });
});
