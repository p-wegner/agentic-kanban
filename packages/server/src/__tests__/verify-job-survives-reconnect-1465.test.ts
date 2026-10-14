import { describe, expect, it, vi } from "vitest";
import { parseBoardToWorkerMessage, parseWorkerToBoardMessage, type BoardToWorkerMessage, type WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import type { Database } from "../db/index.js";

vi.mock("../repositories/preferences.repository.js", () => ({
  getPreference: async () => null,
  setPreference: async () => {},
}));

import { createDaemonVerifyRunner, type StoredVerifyResult, type VerifyResultStore } from "../worker/worker-verify-runner.js";
import { createVerifyWorkerRunner, listActiveVerifyJobs } from "../services/verify-worker-runner.service.js";

const SHA = "b".repeat(40);
const WORKER = { id: "w1", name: "ao-pf38" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A board + one worker over an in-memory wire whose socket can be dropped and restored. */
function wire(graceMs: number) {
  let up = true;
  const messageListeners = new Set<(workerId: string, m: WorkerToBoardMessage) => void>();
  const disconnects = new Set<(id: string) => void>();
  const connects = new Set<(id: string) => void>();
  const frames: BoardToWorkerMessage[] = [];
  const saved = new Map<string, StoredVerifyResult>();
  const store: VerifyResultStore = {
    save: (id, e) => { saved.set(id, e); },
    remove: (id) => { saved.delete(id); },
    loadAll: () => [...saved].map(([jobId, entry]) => ({ jobId, entry })),
  };
  let release: (() => void) | undefined;
  const worker = createDaemonVerifyRunner({
    workRoot: "/tmp/none", boardUrl: () => "http://board:1", slots: 1, ramGb: 32, log: () => {},
    isConnected: () => up,
    store,
    sendToBoard: (m) => {
      if (!up) return; // the real daemon would queue/drop; frames sent into a dead socket never arrive
      const parsed = parseWorkerToBoardMessage(JSON.stringify(m))!;
      for (const l of messageListeners) l(WORKER.id, parsed);
    },
    prepareCheckout: async () => ({ ok: true, dir: "/tmp/co", sha: SHA }),
    runScript: async (_d, script) => {
      if (script.includes("install")) return { exitCode: 0, timedOut: false, output: "" };
      await new Promise<void>((r) => { release = r; });
      return { exitCode: 0, timedOut: false, output: "✓ a.test.ts\n" };
    },
    cleanup: async () => {},
  });
  const connections = {
    isConnected: () => up,
    send: (_id: string, m: BoardToWorkerMessage) => { frames.push(m); worker.handle(parseBoardToWorkerMessage(JSON.stringify(m))!); return true; },
    onMessage: (l: (workerId: string, m: WorkerToBoardMessage) => void) => { messageListeners.add(l); return () => messageListeners.delete(l); },
    onDisconnect: (l: (id: string) => void) => { disconnects.add(l); return () => disconnects.delete(l); },
    onConnect: (l: (id: string) => void) => { connects.add(l); return () => connects.delete(l); },
  };
  const registry = { listWorkersView: async () => [{ ...WORKER, effectiveStatus: "online", verify: worker.capability() }] };
  const runner = createVerifyWorkerRunner({
    database: {} as Database,
    fleet: { connections, registry } as never,
    issueGitAuth: async () => ({ gitPort: 9, gitToken: "tok" }),
    readSetupScript: async () => "pnpm install install",
    reconnectGraceMs: graceMs,
  });
  return {
    runner, frames, worker, saved,
    drop: () => { up = false; for (const l of disconnects) l(WORKER.id); },
    restore: () => { up = true; for (const l of connects) l(WORKER.id); worker.onConnected(); },
    restoreSilent: () => { up = true; for (const l of connects) l(WORKER.id); },
    finishScript: () => release?.(),
  };
}

const request = () => ({ requestId: "job-1", workerId: WORKER.id, sha: SHA, tier: "full", kind: "rc-sweep" as const, command: "pnpm verify", workingDir: "/repo", projectId: "p1", branch: "rc/1", timeoutMs: 60_000 });

describe("a verify job survives a worker reconnect (#1465)", () => {
  it("drops the socket for 2 s mid-run: the board gets the verdict after the reconnect, no refusal, no rerun", async () => {
    const w = wire(30_000);
    const pending = w.runner.run(request());
    await sleep(20);
    w.drop();
    expect(listActiveVerifyJobs()[0]?.disconnectedAt).toBeTruthy();
    await sleep(2000);
    w.finishScript(); // finishes while the socket is down: the verdict is buffered
    await sleep(20);
    expect(w.saved.has("job-1")).toBe(true);
    w.restore();
    const report = await pending;
    expect(report).toMatchObject({ requestId: "job-1", sha: SHA, passed: true });
    expect(report.refused).toBeUndefined();
    expect(w.frames.filter((f) => f.type === "verify_job")).toHaveLength(1);
  }, 10_000);

  it("re-attaches to a job still running on the worker and shows it as re-attached", async () => {
    const w = wire(30_000);
    const pending = w.runner.run(request());
    await sleep(20);
    w.drop();
    w.restore();
    expect(listActiveVerifyJobs()[0]).toMatchObject({ reattached: true });
    expect(listActiveVerifyJobs()[0]?.disconnectedAt).toBeUndefined();
    w.finishScript();
    expect(await pending).toMatchObject({ passed: true });
  });

  it("only a worker that does not come back within the grace is worker_unreachable", async () => {
    const w = wire(60);
    const pending = w.runner.run(request());
    await sleep(20);
    w.drop();
    expect(await pending).toMatchObject({ passed: false, refused: "worker_unreachable" });
    w.finishScript();
  });

  it("a worker that comes back without the job (restarted) is refused after the grace, not left to hang", async () => {
    const w = wire(60);
    const pending = w.runner.run(request());
    await sleep(20);
    w.drop();
    w.restoreSilent(); // a restarted worker process: socket is back, but it knows nothing of the job
    expect(await pending).toMatchObject({ refused: "worker_unreachable" });
    w.finishScript();
  });
});
