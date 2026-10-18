import { describe, expect, it, vi } from "vitest";
import {
  buildWorkerGateScript,
  failedStepFromLog,
  narrowRunnerToWorker,
  runLandLocalWorkerGate,
} from "../services/land-local-worker-gate.service.js";
import type { VerifyWorkerRunner } from "../services/verify-job-placement.js";

const steps = [{ name: "check:arch", command: "pnpm check:arch" }, { name: "typecheck", command: "pnpm typecheck" }];

describe("land-local worker gate (#1612)", () => {
  it("announces each step and names the last announced one on failure", () => {
    const script = buildWorkerGateScript(steps);
    expect(script).toContain("::land-local-step check:arch\" && pnpm check:arch && echo");
    expect(failedStepFromLog("::land-local-step check:arch\nok\n::land-local-step typecheck\nboom", steps)).toBe("typecheck");
    expect(failedStepFromLog("", steps)).toBe("check:arch");
  });

  it("narrows the worker list to the named worker", async () => {
    const base: VerifyWorkerRunner = {
      listWorkers: () => [{ id: "a", name: "alpha", freeSlots: 1 }, { id: "b", name: "beta", freeSlots: 1 }],
      run: vi.fn(),
    };
    expect((await narrowRunnerToWorker(base, "beta").listWorkers()).map((w) => w.id)).toEqual(["b"]);
  });

  it("is unavailable, not green, with no runner registered", async () => {
    const out = await runLandLocalWorkerGate(
      { projectId: "p", branch: "b", sha: "abc", steps, changedFiles: [] },
      { database: {} as never, workerRunner: null },
    );
    expect(out).toMatchObject({ status: "unavailable" });
  });
});
