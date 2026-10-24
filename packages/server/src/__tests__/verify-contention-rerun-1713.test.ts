/**
 * #1713 - a timeouts-only red is contention evidence everywhere, not just at the train gate: the rc
 * sweep / base probe and land-local re-run only the failing suites (one vitest worker) before calling
 * it red, and a worker whose gate runs >2x its own median is flagged.
 */
import { describe, expect, it, vi } from "vitest";
import { resolveRedProbeOutcome } from "../services/base-branch-health.service.js";
import { CONTENTION_RETRY_ENV, MAX_RETRYABLE_SUITES, MAX_TIMEOUT_ONLY_RETRYABLE_SUITES, decideFlakeRetry } from "../services/verify-flake-retry.js";
import { landTrainLocal, type LandLocalDeps } from "../services/train-land-local.service.js";
import { recordVerifyDuration, resetVerifySlowHistory, verifySlowNote } from "../services/verify-slow-worker.js";

const files = (n: number) => Array.from({ length: n }, (_, i) => `src/__tests__/db-heavy-${i}.test.ts`);
const timeoutLog = (n: number) => `[test:mine] server: node vitest run\n${files(n).map((f) => ` FAIL  ${f} > x\nError: Test timed out in 120000ms.`).join("\n")}`;
const assertionLog = (n: number) => `[test:mine] server: node vitest run\n${files(n).map((f) => ` FAIL  ${f} > x\nAssertionError: expected 1 to be 2`).join("\n")}`;
const classify = (suites: { file: string }[]) => ({ files: suites.map((s) => `packages/server/${s.file}`), guardSuites: [], guardFailure: false });

describe("decideFlakeRetry ceiling (#1713)", () => {
  const suites = (n: number) => files(n).map((file) => ({ packageLabel: "server", file }));
  it("lifts the suite ceiling only for a timeouts-only failure", () => {
    expect(decideFlakeRetry({ suites: suites(12), scoped: true }).retry).toBe(false);
    expect(decideFlakeRetry({ suites: suites(12), scoped: true, timeoutOnly: true }).retry).toBe(true);
    expect(decideFlakeRetry({ suites: suites(MAX_TIMEOUT_ONLY_RETRYABLE_SUITES + 1), scoped: true, timeoutOnly: true }).retry).toBe(false);
    expect(MAX_TIMEOUT_ONLY_RETRYABLE_SUITES).toBeGreaterThan(MAX_RETRYABLE_SUITES);
  });
});

describe("rc sweep / base probe (#1713)", () => {
  const run = (combined: string, runRetry: (s: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>) =>
    resolveRedProbeOutcome({ projectId: "p", sha: "s", branch: "rc/1", exitCode: 1, combined, startedAt: 0, nowMs: 1, scoped: true, workingDir: "/x", classifySuites: classify, runRetry });

  it("re-runs a timeouts-only red and records green with a contention note (no heal ticket path)", async () => {
    const runRetry = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const out = await run(timeoutLog(8), runRetry);
    expect(runRetry).toHaveBeenCalledTimes(1);
    expect(out.outcome).toBe("green");
    expect(out.flaky).toBe(true);
    expect(out.message).toContain("contention");
  });

  it("a real assertion failure still reds without a re-run when the set is broad", async () => {
    const runRetry = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const out = await run(assertionLog(8), runRetry);
    expect(runRetry).not.toHaveBeenCalled();
    expect(out.outcome).toBe("red");
  });

  it("a timeouts-only red that fails the isolated re-run stays red", async () => {
    const out = await run(timeoutLog(8), async () => ({ exitCode: 1, stdout: timeoutLog(8), stderr: "" }));
    expect(out.outcome).toBe("red");
  });

  it("the contention env runs one vitest worker", () => {
    expect(CONTENTION_RETRY_ENV.KANBAN_TEST_MAX_WORKERS).toBe("1");
  });
});

describe("land-local (#1713)", () => {
  const members = [{ workspaceId: "w1", issueId: "i1", issueNumber: 11, branch: "feature/ak-11-a" }];
  function make(runOnWorker: LandLocalDeps["runOnWorker"]) {
    const prefs = new Map<string, string>();
    const deps: LandLocalDeps = {
      log: () => {}, runOnWorker,
      getTrain: async () => ({ id: "t1", projectId: "p1", label: "train/x", state: "gating", memberWorkspaceIds: ["w1"] }),
      getTrainProjectId: async () => "p1", getWindowMemberIds: async () => ["w1"],
      loadMembers: async () => members, getProject: async () => ({ repoPath: "/r/proj", defaultBranch: "master" }),
      getPref: async (k) => prefs.get(k) ?? null, setPref: async (k, v) => void prefs.set(k, v), deletePref: async (k) => void prefs.delete(k),
      holdWindow: async () => {}, abandonTrain: vi.fn(async () => {}), createTrainRow: vi.fn(async () => {}), markTrainLanded: vi.fn(async () => {}), closeMember: vi.fn(async () => {}),
      git: async (args) => {
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "master\n", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 1, stdout: "", stderr: "" };
        if (args[0] === "rev-parse") return { code: 0, stdout: "abcdef1234567890\n", stderr: "" };
        return { code: 0, stdout: args[0] === "diff" ? "a.ts\n" : "", stderr: "" };
      },
      run: async () => ({ code: 0, tail: "" }), pathExists: () => false, newId: () => "id", nowIso: () => "2026-10-24T10:00:00.000Z",
    };
    return deps;
  }
  const failing = (log: string) => ({ status: "ran" as const, workerName: "w", passed: false, failedStep: "test:mine", log, failedSuites: [] as string[] });

  it("re-runs timeout-only failures scoped to them and lands when they pass", async () => {
    const runOnWorker = vi.fn()
      .mockResolvedValueOnce(failing(timeoutLog(3)))
      .mockResolvedValueOnce({ status: "ran", workerName: "w", passed: true, log: "" });
    const out = await landTrainLocal({ projectId: "p1", trainId: "t1", onWorker: true }, make(runOnWorker));
    expect(out.status).toBe("landed");
    expect(runOnWorker).toHaveBeenCalledTimes(2);
    expect(runOnWorker.mock.calls[1]![0].retryScope).toContain("server:src/__tests__/db-heavy-0.test.ts");
  });

  it("a real assertion failure reds without a re-run", async () => {
    const runOnWorker = vi.fn().mockResolvedValue(failing(assertionLog(8)));
    const out = await landTrainLocal({ projectId: "p1", trainId: "t1", onWorker: true }, make(runOnWorker));
    expect(out.status).toBe("red");
    expect(runOnWorker).toHaveBeenCalledTimes(1);
  });
});

describe("slow worker marker (#1713)", () => {
  it("flags a gate over 2x the median, not before there is history", () => {
    resetVerifySlowHistory();
    expect(verifySlowNote(2814_000, [])).toBeNull();
    expect(verifySlowNote(2814_000, [1100_000, 1000_000, 1200_000])).toBe("verify slow: 2814 s vs median 1100 s");
    expect(verifySlowNote(2000_000, [1100_000, 1000_000, 1200_000])).toBeNull();
  });
  it("records per worker and scope", () => {
    resetVerifySlowHistory();
    for (const d of [1000_000, 1100_000, 1200_000]) expect(recordVerifyDuration("w", "rc-sweep|full", d)).toBeNull();
    expect(recordVerifyDuration("w", "rc-sweep|full", 3000_000)).toContain("verify slow");
    expect(recordVerifyDuration("w", "train-gate|full", 3000_000)).toBeNull();
  });
});
