import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseBoardToWorkerMessage, parseWorkerToBoardMessage, type BoardToWorkerMessage, type WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import { VERIFY_LOG_CHUNK_BYTES } from "@agentic-kanban/shared/lib/worker-verify-protocol";
import type { Database } from "../db/index.js";

const prefs = new Map<string, string>();
vi.mock("../repositories/preferences.repository.js", () => ({
  getPreference: async (key: string) => prefs.get(key) ?? null,
  setPreference: async (key: string, value: string) => { prefs.set(key, value); },
}));

import { createDaemonVerifyRunner, type CheckoutOutcome, type ScriptOutcome } from "../worker/worker-verify-runner.js";
import { createVerifyWorkerRunner, listActiveVerifyJobs } from "../services/verify-worker-runner.service.js";
import { planVerifyPlacement, runOnPlannedWorker, runPlacedVerifyCommand } from "../services/verify-job-placement.js";
import { runProbeOnWorker } from "../services/base-branch-health-placement.js";
import { planGateRun } from "../services/pre-merge-gate-placement.js";
import type { BaseBranchVerifyResult } from "../services/base-branch-health.service.js";

const db = {} as Database;
// #1713: failed-output logs go to a temp dir, never the real verify-log directory.
const LOG_DIR = mkdtempSync(join(tmpdir(), "verify-runner-test-"));
afterAll(() => rmSync(LOG_DIR, { recursive: true, force: true }));
const SHA = "a".repeat(40);
const WORKER = { id: "w1", name: "desktop-stable" };

/** A board + one worker joined by an in-memory wire that round-trips every frame through the real JSON parsers. */
function wire(opts: { checkout?: CheckoutOutcome; script?: ScriptOutcome; slots?: number } = {}) {
  const listeners = new Set<(workerId: string, m: WorkerToBoardMessage) => void>();
  const disconnects = new Set<(id: string) => void>();
  const seen: WorkerToBoardMessage[] = [];
  const worker = createDaemonVerifyRunner({
    workRoot: "/tmp/none",
    boardUrl: () => "http://board:1",
    slots: opts.slots ?? 1,
    ramGb: 32,
    log: () => {},
    sendToBoard: (m) => {
      const parsed = parseWorkerToBoardMessage(JSON.stringify(m));
      expect(parsed).not.toBeNull();
      seen.push(parsed!);
      for (const l of listeners) l(WORKER.id, parsed!);
    },
    prepareCheckout: async () => opts.checkout ?? { ok: true, dir: "/tmp/co", sha: SHA },
    runScript: async (_dir, script) => (script.includes("install") ? { exitCode: 0, timedOut: false, output: "installed\n" } : opts.script ?? { exitCode: 0, timedOut: false, output: "✓ a.test.ts\n" }),
    cleanup: async () => {},
  });
  const frames: BoardToWorkerMessage[] = [];
  const connections = {
    isConnected: () => true,
    send: (_id: string, m: BoardToWorkerMessage) => {
      const parsed = parseBoardToWorkerMessage(JSON.stringify(m));
      expect(parsed).not.toBeNull();
      frames.push(parsed!);
      worker.handle(parsed!);
      return true;
    },
    onMessage: (l: (workerId: string, m: WorkerToBoardMessage) => void) => { listeners.add(l); return () => listeners.delete(l); },
    onDisconnect: (l: (id: string) => void) => { disconnects.add(l); return () => disconnects.delete(l); },
  };
  const registry = {
    listWorkersView: async () => [{ ...WORKER, effectiveStatus: "online", verify: worker.capability(), capacity: { freeRamGb: 20, spareCores: 8, thrashing: "none" } }],
  };
  const runner = createVerifyWorkerRunner({
    database: db,
    fleet: { connections, registry } as never,
    issueGitAuth: async () => ({ gitPort: 9, gitToken: "tok" }),
    readSetupScript: async () => "pnpm install install",
    logDir: LOG_DIR,
  });
  return { runner, frames, seen, worker };
}

const request = (over: Record<string, unknown> = {}) => ({
  requestId: "job-1", workerId: WORKER.id, sha: SHA, tier: "full", kind: "rc-sweep" as const, command: "pnpm verify", workingDir: "/repo", projectId: "p1", branch: "rc/1", timeoutMs: 1000, ...over,
});

describe("verify job frames: board ↔ worker round trip (#1437)", () => {
  it("sends one verify_job, relays progress and a chunked log, and returns the worker's own sha", async () => {
    const bigLog = "x".repeat(VERIFY_LOG_CHUNK_BYTES * 2 + 5);
    const { runner, frames, seen } = wire({ script: { exitCode: 0, timedOut: false, output: bigLog } });
    const report = await runner.run(request());
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "verify_job", jobId: "job-1", sha: SHA, script: "pnpm verify", setupScript: "pnpm install install" });
    expect(report).toMatchObject({ requestId: "job-1", workerId: "w1", sha: SHA, tier: "full", passed: true, exitCode: 0 });
    expect(report.log).toContain(bigLog); // reassembled from 3+ chunks
    expect(seen.filter((m) => m.type === "verify_log_chunk").length).toBeGreaterThanOrEqual(3);
    expect(seen.some((m) => m.type === "verify_progress" && m.stage === "verify")).toBe(true);
    expect(listActiveVerifyJobs()).toHaveLength(0); // cleared once the result lands
  });

  it("a red run carries its failing suites and exit code", async () => {
    const { runner } = wire({ script: { exitCode: 1, timedOut: false, output: " FAIL  packages/a/__tests__/x.test.ts > boom\n" } });
    const report = await runner.run(request());
    expect(report).toMatchObject({ passed: false, exitCode: 1, failingSuites: ["packages/a/__tests__/x.test.ts"] });
  });

  it("advertises capability: slots, free slots and RAM", () => {
    expect(wire({ slots: 2 }).worker.capability()).toEqual({ slots: 2, freeSlots: 2, ramGb: 32, jobIds: [] });
  });

  it("lists the worker as a candidate with its free slots", async () => {
    expect(await wire().runner.listWorkers()).toEqual([expect.objectContaining({ id: "w1", name: "desktop-stable", freeSlots: 1, freeRamGb: 20 })]);
  });
});

describe("sha mismatch refusal (#1437)", () => {
  it("the worker refuses when its checkout is not the job's sha, and the board treats it as not-a-verdict", async () => {
    const other = "b".repeat(40);
    const { runner } = wire({ checkout: { ok: false, refused: "sha_mismatch", reason: `checkout is ${other}`, sha: other } });
    prefs.set("verify_placement_p1", "worker");
    prefs.set("verify_workers_p1", "desktop-stable");
    const out = await runPlacedVerifyCommand({
      kind: "rc-sweep", projectId: "p1", database: db, command: "pnpm verify", workingDir: "/repo", sha: SHA, tier: "full",
      runOnHost: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })), workerRunner: runner, log: () => {},
    });
    expect(out.refused).toContain("sha_mismatch");
    expect(out.result.exitCode).toBe(-1);
  });

  it("a worker that reports a different sha than it was sent is refused even without a refusal flag", async () => {
    const { runner } = wire({ checkout: { ok: true, dir: "/tmp/co", sha: "c".repeat(40) } });
    prefs.set("verify_placement_p1", "worker");
    prefs.set("verify_workers_p1", "desktop-stable");
    const plan = await planVerifyPlacement({ kind: "rc-sweep", projectId: "p1", database: db, workerRunner: runner });
    expect(plan.target).toBe("worker");
    const out = await runOnPlannedWorker(plan as never, { kind: "rc-sweep", projectId: "p1", database: db, command: "x", workingDir: "/r", sha: SHA, tier: "full", runOnHost: async () => ({ exitCode: 0, stdout: "", stderr: "" }), log: () => {} });
    expect(out.refused).toMatch(/verdict is for/);
  });

  it("a worker with no free slot refuses and verifies nothing", async () => {
    const { worker } = wire({ slots: 1 });
    const sent: WorkerToBoardMessage[] = [];
    const full = createDaemonVerifyRunner({
      workRoot: "/x", boardUrl: () => "", slots: 0, ramGb: 1, log: () => {}, sendToBoard: (m) => sent.push(m),
      prepareCheckout: async () => { throw new Error("must not check out"); },
    });
    full.handle({ type: "verify_job", jobId: "j", sha: SHA, branch: "b", kind: "k", tier: "full", script: "s", timeoutMs: 1, auth: { projectId: "p", gitPort: 1, gitToken: "t", branch: "b", incomingRef: "r" } } as never);
    await vi.waitFor(() => expect(sent.some((m) => m.type === "verify_result")).toBe(true));
    expect(sent.find((m) => m.type === "verify_result")).toMatchObject({ passed: false, refused: "no_free_slot" });
    expect(worker).toBeDefined();
  });
});

describe("held-to-worker fallback (#1437)", () => {
  const held = { admit: false as const, reason: "host_saturated" as const, detail: "1.6 GB free" };
  const gateArgs = { projectId: "p1", workspaceId: "ws1", database: db, workingDir: "/nowhere", verifyScript: "pnpm verify", timeoutMs: 1000, tier: "full" };

  it("prefer-worker + a held host + an allowlisted worker → the gate proceeds on the worker", async () => {
    prefs.set("verify_placement_p1", "prefer-worker");
    prefs.set("verify_workers_p1", "desktop-stable");
    const { runner } = wire();
    const plan = await planVerifyPlacement({ kind: "workspace-gate", projectId: "p1", database: db, hostHeld: true, workerRunner: runner });
    expect(plan).toMatchObject({ target: "worker", workerName: "desktop-stable" });
    const hostOnly = await planVerifyPlacement({ kind: "workspace-gate", projectId: "p1", database: db, hostHeld: false, workerRunner: runner });
    expect(hostOnly.target).toBe("host"); // host has room → no remote placement
  });

  it("prefer-worker with NO eligible worker holds exactly as today", async () => {
    prefs.set("verify_placement_p1", "prefer-worker");
    prefs.set("verify_workers_p1", "someone-else");
    const plan = await planGateRun({ ...gateArgs, admission: held });
    expect(plan.proceed).toBe(false);
    expect(plan.hold.message).toContain("HELD");
    expect(plan.hold.message).toContain("1.6 GB free");
  });

  it("host placement is untouched: held stays held, admitted runs on the host", async () => {
    prefs.clear();
    expect((await planGateRun({ ...gateArgs, admission: held })).proceed).toBe(false);
    const ok = await planGateRun({ ...gateArgs, admission: { admit: true, reason: "host_has_room" } as never });
    expect(ok).toMatchObject({ proceed: true });
    expect(ok.run).toBeUndefined();
  });
});

describe("sweep verdict is stored like a host run (#1437)", () => {
  const baseArgs = (finish: (r: BaseBranchVerifyResult, c: string) => Promise<BaseBranchVerifyResult>, plan: unknown) => ({
    plan: plan as never, kind: "rc-sweep" as const, projectId: "p1", database: db, repoPath: "/repo", branch: "rc/1", sha: SHA,
    verifyScript: "pnpm verify", timeoutMs: 1000, finish, stampKey: "base_health_probe_started_p1",
  });

  it("a green worker sweep yields the host result shape, names the worker, and clears the in-flight stamp", async () => {
    prefs.set("verify_placement_p1", "worker");
    prefs.set("verify_workers_p1", "desktop-stable");
    const { runner } = wire();
    const plan = await planVerifyPlacement({ kind: "rc-sweep", projectId: "p1", database: db, workerRunner: runner });
    const finish = vi.fn(async (r: BaseBranchVerifyResult) => r);
    const result = await runProbeOnWorker(baseArgs(finish, plan));
    expect(Object.keys(result).sort()).toEqual(expect.arrayContaining(["branch", "durationMs", "failedSuites", "message", "outcome", "sha"]));
    expect(result).toMatchObject({ outcome: "green", sha: SHA, branch: "rc/1", failedSuites: [] });
    expect(result.message).toContain("desktop-stable");
    expect(prefs.get("base_health_probe_started_p1")).toBe("");
  });

  it("a red worker sweep is a red row with the failing suites and the host's red wording", async () => {
    const { runner } = wire({ script: { exitCode: 1, timedOut: false, output: " FAIL  packages/a/__tests__/x.test.ts > boom\n" } });
    const plan = await planVerifyPlacement({ kind: "rc-sweep", projectId: "p1", database: db, workerRunner: runner });
    const result = await runProbeOnWorker(baseArgs(async (r) => r, plan));
    expect(result.outcome).toBe("red");
    expect(result.failedSuites).toEqual(["packages/a/__tests__/x.test.ts"]);
    expect(result.message).toContain("desktop-stable");
  });

  it("a refused worker sweep is `unverified`, never red or green", async () => {
    const { runner } = wire({ checkout: { ok: false, refused: "sha_unavailable", reason: "cannot fetch" } });
    const plan = await planVerifyPlacement({ kind: "rc-sweep", projectId: "p1", database: db, workerRunner: runner });
    const result = await runProbeOnWorker(baseArgs(async (r) => r, plan));
    expect(result.outcome).toBe("unverified");
  });
});
