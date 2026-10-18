import { describe, expect, it } from "vitest";
import { setPreference } from "../repositories/preferences.repository.js";
import { createTestDb } from "./helpers/test-db.js";
import { runOnPlannedWorker, type PlaceVerifyCommandArgs, type VerifyPlan, type VerifyRunRequest, type VerifyWorkerRunner } from "../services/verify-job-placement.js";
import {
  decideVerifyPlacement,
  isTimeoutOnlyFailure,
  workerAdmitsAnotherChain,
  workerWasAtCapacity,
  verifyPlacementPrefKey,
  verifyWorkersPrefKey,
  type VerifyWorkerCandidate,
  type WorkerVerifyReport,
} from "../services/verify-placement.js";

// #1589: worker placement applies the host's slot admission; a timeout-only red from an over-capacity run is re-run once.
describe("worker chain admission (#1589)", () => {
  it("an idle worker admits a chain; a busy one only with RAM for another over the reserve", () => {
    expect(workerAdmitsAnotherChain(0, 1)).toBe(true);
    expect(workerAdmitsAnotherChain(1, 4.9)).toBe(false);
    expect(workerAdmitsAnotherChain(1, 5)).toBe(true);
    expect(workerAdmitsAnotherChain(1, undefined)).toBe(false);
  });

  it("two placement requests against one worker with one slot: the second is held / goes elsewhere", () => {
    const allow = new Set(["w1", "w2"]);
    const busy: VerifyWorkerCandidate = { id: "w1", name: "w1", freeSlots: 0 };
    expect(decideVerifyPlacement({ placement: "worker", kind: "train-gate", hostHeld: false, allowlist: allow, workers: [busy] })).toMatchObject({ target: "hold" });
    const idle: VerifyWorkerCandidate = { id: "w2", name: "w2", freeSlots: 1 };
    expect(decideVerifyPlacement({ placement: "worker", kind: "train-gate", hostHeld: false, allowlist: allow, workers: [busy, idle] })).toMatchObject({ target: "worker", workerId: "w2" });
  });

  it("classifies load: another chain beside it, or RAM under the reserve", () => {
    expect(workerWasAtCapacity(1, 20)).toBe(true);
    expect(workerWasAtCapacity(0, 1.5)).toBe(true);
    expect(workerWasAtCapacity(0, 20)).toBe(false);
  });

  it("timeout-only failures are told apart from assertion failures", () => {
    expect(isTimeoutOnlyFailure("FAIL x.test.ts\nError: Test timed out in 90000ms.")).toBe(true);
    expect(isTimeoutOnlyFailure("Error: Test timed out in 90000ms.\nAssertionError: expected 1 to be 2")).toBe(false);
    expect(isTimeoutOnlyFailure("all good")).toBe(false);
  });
});

describe("load-suspect red is re-run once (#1589)", () => {
  const plan = (id: string, runner: VerifyWorkerRunner): Extract<VerifyPlan, { target: "worker" }> => ({
    target: "worker", reason: "t", workerId: id, workerName: id, active: runner, allowlist: new Set(["w1", "w2"]),
  });
  const args = (runner: VerifyWorkerRunner): PlaceVerifyCommandArgs => ({
    kind: "train-gate", projectId: "p", database: {} as never, command: "x", workingDir: ".", sha: "abc", tier: "full",
    runOnHost: async () => ({ exitCode: 0, stdout: "", stderr: "" }), workerRunner: runner, log: () => {},
  });

  it("re-runs on a free worker and believes the second verdict", async () => {
    const calls: string[] = [];
    const runner: VerifyWorkerRunner = {
      listWorkers: () => [{ id: "w2", name: "w2", freeSlots: 1 }],
      run: async (r: VerifyRunRequest): Promise<WorkerVerifyReport> => {
        calls.push(r.workerId);
        const first = calls.length === 1;
        return { requestId: r.requestId, workerId: r.workerId, sha: r.sha, tier: r.tier, passed: !first, exitCode: first ? 1 : 0, ...(first ? { loadSuspect: true, log: "Test timed out in 90000ms" } : {}) };
      },
    };
    const { db } = createTestDb();
    await setPreference(verifyPlacementPrefKey("p"), "worker", db);
    await setPreference(verifyWorkersPrefKey("p"), "w1,w2", db);
    const out = await runOnPlannedWorker(plan("w1", runner), { ...args(runner), database: db });
    expect(calls).toEqual(["w1", "w2"]);
    expect(out.result.exitCode).toBe(0);
    expect(out.workerName).toBe("w2");
  });

  it("does not retry a retry", async () => {
    const calls: string[] = [];
    const runner: VerifyWorkerRunner = {
      listWorkers: () => [],
      run: async (r) => { calls.push(r.workerId); return { requestId: r.requestId, workerId: r.workerId, sha: r.sha, tier: r.tier, passed: false, exitCode: 1, loadSuspect: true }; },
    };
    const out = await runOnPlannedWorker(plan("w1", runner), args(runner), true);
    expect(calls).toEqual(["w1"]);
    expect(out.result.exitCode).toBe(1);
  });
});
