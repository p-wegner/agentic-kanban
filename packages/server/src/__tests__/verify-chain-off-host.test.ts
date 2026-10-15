import { beforeEach, describe, expect, it } from "vitest";
import { runVerifyChainForPlacement } from "../services/pre-merge-gate-placement.js";
import { listVerifyChains, resetVerifyChainSemaphoreForTests, verifyChainSemaphoreActive } from "../services/verify-chain-semaphore.js";

describe("runVerifyChainForPlacement (#1497)", () => {
  beforeEach(() => resetVerifyChainSemaphoreForTests());

  it("a worker-placed chain takes no host slot, is listed on its worker, and never queues behind a host chain", async () => {
    let release!: () => void;
    const hostHeld = runVerifyChainForPlacement(undefined, () => new Promise<void>((r) => { release = r; }), "host chain");
    await Promise.resolve();
    expect(verifyChainSemaphoreActive()).toBe(1);

    let seen: ReturnType<typeof listVerifyChains> = [];
    const out = await runVerifyChainForPlacement("ao-pf38", async () => { seen = listVerifyChains(); return 7; }, "worker chain");
    expect(out).toEqual({ result: 7, queueWaitMs: 0, lockNote: null });
    expect(seen.find((c) => c.label === "worker chain")).toMatchObject({ state: "running", worker: "ao-pf38" });
    expect(verifyChainSemaphoreActive()).toBe(1);
    expect(listVerifyChains().some((c) => c.label === "worker chain")).toBe(false);

    release();
    await hostHeld;
    expect(verifyChainSemaphoreActive()).toBe(0);
  });
});
