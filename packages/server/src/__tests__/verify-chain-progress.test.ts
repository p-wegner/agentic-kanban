import { describe, it, expect, beforeEach } from "vitest";
import { createVerifyOutputSink, stageOfGatePhase } from "../services/verify-chain-progress.js";
import { listRunningVerifyChains, reportVerifyChainProgress } from "../services/verify-chain-registry.js";
import { resetVerifyChainSemaphoreForTests, runUnderVerifyChainSemaphore } from "../services/verify-chain-semaphore.js";

describe("createVerifyOutputSink (#1462)", () => {
  it("reports stage changes and vitest file progress across split chunks", () => {
    const patches: Array<Record<string, unknown>> = [];
    const sink = createVerifyOutputSink((p) => patches.push({ ...p }));
    sink("> pnpm check:arch\nok\n> pnpm typecheck\n");
    sink(" ✓ packages/a/__tests__/x.test.ts (3 te");
    sink("sts)\n ✓ packages/a/__tests__/y.test.ts (1 test)\n");
    sink(" Test Files  2 passed (2)\n");
    expect(patches).toEqual([
      { stage: "arch" },
      { stage: "typecheck" },
      { stage: "tests", filesDone: 1 },
      { filesDone: 2 },
      { filesDone: 2, filesTotal: 2 },
    ]);
  });

  it("maps gate phases onto chain stages and ignores queue/hold", () => {
    expect(stageOfGatePhase("install")).toBe("setup");
    expect(stageOfGatePhase("queued")).toBeNull();
    expect(stageOfGatePhase("held")).toBeNull();
  });
});

describe("running verify chains (#1462)", () => {
  beforeEach(() => resetVerifyChainSemaphoreForTests());

  it("lists a running chain with its reported progress and drops it on exit", async () => {
    let during: ReturnType<typeof listRunningVerifyChains> = [];
    await runUnderVerifyChainSemaphore(async () => {
      reportVerifyChainProgress("chain-a", { stage: "tests", filesDone: 4, filesTotal: 10 });
      during = listRunningVerifyChains();
    }, "chain-a");
    expect(during).toHaveLength(1);
    expect(during[0]).toMatchObject({ label: "chain-a", stage: "tests", filesDone: 4, filesTotal: 10 });
    expect(during[0].startedAtMs).toBeGreaterThan(0);
    expect(listRunningVerifyChains()).toEqual([]);
  });
});
