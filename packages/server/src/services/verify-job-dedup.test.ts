import { describe, expect, it, vi } from "vitest";

vi.mock("../repositories/preferences.repository.js", () => ({
  getPreference: async (key: string) => (key.includes("workers") ? "w1" : "worker"),
}));

import { runPlacedVerifyCommand, type VerifyWorkerRunner } from "./verify-job-placement.js";

describe("verify job dedup (#1778)", () => {
  it("joins a second request for the same sha+command onto the run in flight", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const runner: VerifyWorkerRunner = {
      listWorkers: () => [{ id: "w1", name: "w1", freeSlots: 1, freeRamGb: 32 }],
      run: async (req) => { runs++; await gate; return { requestId: req.requestId, workerId: req.workerId, sha: req.sha, tier: req.tier, passed: true, log: "ok", exitCode: 0 }; },
    };
    const database = { } as never;
    const base = { projectId: "p", database, command: "pnpm typecheck", workingDir: "/x", sha: "abc123", tier: "t", workerRunner: runner, log: () => {}, runOnHost: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
    const a = runPlacedVerifyCommand({ ...base, kind: "implement-exit" });
    await new Promise((r) => setTimeout(r, 20));
    const b = runPlacedVerifyCommand({ ...base, kind: "workspace-gate" });
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(runs).toBe(1);
    expect(rb).toBe(ra);
  });
});
