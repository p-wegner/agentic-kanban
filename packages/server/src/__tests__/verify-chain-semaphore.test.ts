import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetVerifyChainSemaphoreForTests,
  runUnderVerifyChainSemaphore,
  verifyChainSemaphoreActive,
  verifyChainSemaphoreConcurrency,
  verifyChainSemaphoreQueueLength,
} from "../services/verify-chain-semaphore.js";

/**
 * #903 — verify chains from DIFFERENT workspaces must not interleave. `runUnderBuildSemaphore`
 * already caps individual heavyweight invocations (default 2), but two workspaces' whole CHAINS
 * (first run + install retry + flake retry) could still run concurrently inside that cap. This
 * semaphore serializes at the chain level instead, default concurrency 1.
 */
describe("verify-chain-semaphore (#903)", () => {
  beforeEach(() => {
    resetVerifyChainSemaphoreForTests();
    delete process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY;
  });
  afterEach(() => {
    resetVerifyChainSemaphoreForTests();
    delete process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY;
  });

  it("defaults to concurrency 1", () => {
    expect(verifyChainSemaphoreConcurrency()).toBe(1);
  });

  it("honors KANBAN_VERIFY_CHAIN_CONCURRENCY, clamped to >= 1", () => {
    process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY = "3";
    expect(verifyChainSemaphoreConcurrency()).toBe(3);
    process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY = "0";
    expect(verifyChainSemaphoreConcurrency()).toBe(1);
    process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY = "not-a-number";
    expect(verifyChainSemaphoreConcurrency()).toBe(1);
  });

  it("serializes two concurrent chains: the second does not start until the first finishes", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = runUnderVerifyChainSemaphore(async () => {
      order.push("first-start");
      await firstGate;
      order.push("first-end");
    });

    // Give the first chain a tick to actually enter the semaphore before starting the second.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(verifyChainSemaphoreActive()).toBe(1);

    const second = runUnderVerifyChainSemaphore(async () => {
      order.push("second-start");
    });

    // The second chain must be queued, not running, while the first is still active.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(verifyChainSemaphoreQueueLength()).toBe(1);
    expect(order).toEqual(["first-start"]);

    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("releases the slot even when the chain throws, so a failing chain does not wedge the queue", async () => {
    const failing = runUnderVerifyChainSemaphore(async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    expect(verifyChainSemaphoreActive()).toBe(0);

    // A subsequent chain must be able to run immediately — the queue was not wedged.
    let ran = false;
    await runUnderVerifyChainSemaphore(async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it("a raised concurrency allows N chains to run simultaneously", async () => {
    process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY = "2";
    const activeDuring: number[] = [];
    let releaseAll: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseAll = resolve; });

    const chains = [1, 2].map(() =>
      runUnderVerifyChainSemaphore(async () => {
        activeDuring.push(verifyChainSemaphoreActive());
        await gate;
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(verifyChainSemaphoreActive()).toBe(2);
    releaseAll();
    await Promise.all(chains);
  });
});
