import { describe, expect, it, vi } from "vitest";
import { parseBoardToWorkerMessage, type BoardToWorkerMessage, type WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import type { Database } from "../db/index.js";

vi.mock("../repositories/preferences.repository.js", () => ({
  getPreference: async () => null,
  setPreference: async () => {},
}));

import { createDaemonVerifyRunner } from "../worker/worker-verify-runner.js";
import { createVerifyWorkerRunner, listActiveVerifyJobs } from "../services/verify-worker-runner.service.js";

const SHA = "c".repeat(40);
const WORKER = { id: "w1", name: "ao-pf38" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function wire() {
  const frames: BoardToWorkerMessage[] = [];
  const toBoard: WorkerToBoardMessage[] = [];
  const cleaned: string[] = [];
  const scriptSignals: AbortSignal[] = [];
  const saved = new Map<string, never>();
  const worker = createDaemonVerifyRunner({
    workRoot: "/tmp/none", boardUrl: () => "http://board:1", slots: 2, ramGb: 32, log: () => {},
    sendToBoard: (m) => { toBoard.push(m); },
    prepareCheckout: async (job) => ({ ok: true, dir: `/tmp/co-${job.jobId}`, sha: SHA }),
    runScript: async (_d, script, opts) => {
      if (script.includes("install")) return { exitCode: 0, timedOut: false, output: "" };
      if (opts.signal) scriptSignals.push(opts.signal);
      // Like the real runner: a kill ends the script (non-zero), a normal run would sit here for minutes.
      await new Promise<void>((r) => opts.signal?.addEventListener("abort", () => r(), { once: true }));
      return { exitCode: 1, timedOut: false, output: "killed" };
    },
    cleanup: async (_job, dir) => { cleaned.push(dir); },
    store: { save: (id) => { saved.set(id, undefined as never); }, remove: (id) => { saved.delete(id); }, loadAll: () => [] },
  });
  const connections = {
    isConnected: () => true,
    send: (_id: string, m: BoardToWorkerMessage) => { frames.push(m); worker.handle(parseBoardToWorkerMessage(JSON.stringify(m))!); return true; },
    onMessage: () => () => {},
    onDisconnect: () => () => {},
    onConnect: () => () => {},
  };
  const registry = { listWorkersView: async () => [{ ...WORKER, effectiveStatus: "online", verify: worker.capability() }] };
  const runner = createVerifyWorkerRunner({
    database: {} as Database,
    fleet: { connections, registry } as never,
    issueGitAuth: async () => ({ gitPort: 9, gitToken: "tok" }),
    readSetupScript: async () => "pnpm install install",
  });
  return { runner, frames, toBoard, cleaned, scriptSignals, saved, worker };
}

const request = (id: string, signal?: AbortSignal) => ({
  requestId: id, workerId: WORKER.id, sha: SHA, tier: "full", kind: "train-gate" as const, command: "pnpm verify",
  workingDir: "/repo", projectId: "p1", branch: "t", timeoutMs: 60_000, signal,
});

describe("cancelling a placed verify job reaches the worker (#1489)", () => {
  it("an aborted owner sends verify_cancel; the worker kills the script, removes the checkout and keeps no verdict", async () => {
    const w = wire();
    const ac = new AbortController();
    const pending = w.runner.run(request("job-a", ac.signal));
    await sleep(20);
    expect(w.scriptSignals).toHaveLength(1);
    ac.abort();
    const report = await pending;
    expect(report.passed).toBe(false);
    expect(report.refused).toBe("cancelled");
    expect(w.frames.some((f) => f.type === "verify_cancel" && f.jobId === "job-a")).toBe(true);
    await sleep(20);
    expect(w.scriptSignals[0].aborted).toBe(true);
    expect(w.cleaned).toEqual(["/tmp/co-job-a"]);
    expect(w.saved.size).toBe(0);
    expect(w.toBoard.some((m) => m.type === "verify_result")).toBe(false);
    expect(w.worker.capability().freeSlots).toBe(2);
    expect(listActiveVerifyJobs()).toHaveLength(0);
  });

  it("an already-aborted signal still cancels the job it just placed", async () => {
    const w = wire();
    const ac = new AbortController();
    ac.abort();
    const report = await w.runner.run(request("job-b", ac.signal));
    expect(report.refused).toBe("cancelled");
    await sleep(20);
    expect(w.cleaned).toEqual(["/tmp/co-job-b"]);
  });

  it("verify_live_jobs reaps every running job the board does not name", async () => {
    const w = wire();
    for (const id of ["keep", "drop"]) void w.worker.handle({ type: "verify_job", jobId: id, sha: SHA, branch: "", kind: "train-gate", tier: "full", script: "pnpm verify", timeoutMs: 60_000, auth: { projectId: "p1", gitPort: 9, gitToken: "t", branch: "b", incomingRef: "r" } } as never);
    await sleep(20);
    expect(w.worker.capability().freeSlots).toBe(0);
    w.worker.handle(parseBoardToWorkerMessage(JSON.stringify({ type: "verify_live_jobs", jobIds: ["keep"] }))!);
    await sleep(20);
    expect(w.cleaned).toEqual(["/tmp/co-drop"]);
    expect(w.worker.capability().freeSlots).toBe(1);
    w.worker.cancel("keep");
    await sleep(20);
    expect(w.worker.capability().freeSlots).toBe(2);
  });

  it("cancelling an unknown job is a no-op and the frames round-trip the wire parser", () => {
    const w = wire();
    expect(w.worker.cancel("nope")).toBe(false);
    expect(parseBoardToWorkerMessage(JSON.stringify({ type: "verify_cancel", jobId: "x" }))).toEqual({ type: "verify_cancel", jobId: "x" });
    expect(parseBoardToWorkerMessage(JSON.stringify({ type: "verify_live_jobs", jobIds: ["a", 3, "b"] }))).toEqual({ type: "verify_live_jobs", jobIds: ["a", "b"] });
    expect(parseBoardToWorkerMessage(JSON.stringify({ type: "verify_cancel" }))).toBeNull();
  });
});
