import { describe, expect, it, vi } from "vitest";
import type { Database } from "../db/index.js";

const prefs = new Map<string, string>();
vi.mock("../repositories/preferences.repository.js", () => ({
  getPreference: async (key: string) => prefs.get(key) ?? null,
}));

import { runPlacedVerifyCommand, VerifyJobHeldError, type VerifyWorkerRunner } from "../services/verify-job-placement.js";

const db = {} as Database;
const SHA = "a".repeat(40);
const ok = { exitCode: 0, stdout: "host", stderr: "" };
const base = (over: Record<string, unknown> = {}) => ({
  kind: "review-exit-typecheck" as const,
  projectId: "p1",
  database: db,
  command: "pnpm typecheck",
  workingDir: "/w",
  sha: SHA,
  tier: "typecheck",
  runOnHost: vi.fn(async () => ok),
  log: () => {},
  ...over,
});
const worker = (report?: Partial<{ sha: string; passed: boolean }>): VerifyWorkerRunner => ({
  listWorkers: () => [{ id: "w1", name: "desk", freeSlots: 1 }],
  run: async (req) => ({ requestId: req.requestId, workerId: req.workerId, sha: report?.sha ?? req.sha, tier: req.tier, passed: report?.passed ?? true }),
});

describe("placed verify command (#1430)", () => {
  it("runs on the host by default", async () => {
    prefs.clear();
    const args = base({ workerRunner: worker() });
    expect((await runPlacedVerifyCommand(args)).target).toBe("host");
    expect(args.runOnHost).toHaveBeenCalled();
  });

  it("worker placement runs on the allowlisted worker and maps the verdict", async () => {
    prefs.set("verify_placement_p1", "worker");
    prefs.set("verify_workers_p1", "desk");
    const args = base({ workerRunner: worker({ passed: false }) });
    const r = await runPlacedVerifyCommand(args);
    expect(r).toMatchObject({ target: "worker", workerName: "desk", result: { exitCode: 1 } });
    expect(args.runOnHost).not.toHaveBeenCalled();
  });

  it("refuses a verdict for another sha as a failed run", async () => {
    const r = await runPlacedVerifyCommand(base({ workerRunner: worker({ sha: "b".repeat(40) }) }));
    expect(r.result.exitCode).toBe(-1);
    expect(r.result.stderr).toContain("refused");
  });

  it("worker placement with no runner holds instead of using the host", async () => {
    const args = base({ workerRunner: null });
    await expect(runPlacedVerifyCommand(args)).rejects.toBeInstanceOf(VerifyJobHeldError);
    expect(args.runOnHost).not.toHaveBeenCalled();
  });

  it("prefer-worker with no runner falls back to the host", async () => {
    prefs.set("verify_placement_p1", "prefer-worker");
    expect((await runPlacedVerifyCommand(base({ workerRunner: null, hostHeld: true }))).target).toBe("host");
  });
});
