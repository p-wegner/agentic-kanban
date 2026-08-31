import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  resetVerifyChainSemaphoreForTests,
  runUnderVerifyChainSemaphore,
  runUnderVerifyChainSemaphoreTimed,
  verifyChainSemaphoreActive,
  verifyChainSemaphoreConcurrency,
  verifyChainSemaphoreQueueLength,
} from "../services/verify-chain-semaphore.js";
import {
  MACHINE_LOCK_DIR_ENV,
  MACHINE_LOCK_ENV,
  machineVerifyLockPath,
} from "../lib/machine-verify-lock.js";

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

/**
 * #949 — the queue wait must be REPORTABLE, and it must be reported to the waiter itself.
 *
 * Two gates on one box were observed at 20 min and >45 min wall with nothing anywhere saying
 * the second spent most of that queued rather than working, so the box read as broken instead
 * of busy. The gate already treats "the conditions a verdict was produced under" as part of the
 * verdict (`GateTierInfo.buildersQuiesced`); a long queue wait is one of those conditions.
 */
describe("verify-chain-semaphore queue-wait reporting (#949)", () => {
  beforeEach(() => {
    resetVerifyChainSemaphoreForTests();
    delete process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY;
  });
  afterEach(() => {
    resetVerifyChainSemaphoreForTests();
    delete process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY;
  });

  it("reports a zero wait for an uncontended acquisition", async () => {
    const { result, queueWaitMs } = await runUnderVerifyChainSemaphoreTimed(async () => "done");
    expect(result).toBe("done");
    expect(queueWaitMs).toBe(0);
  });

  it("reports a NON-zero wait to the chain that actually queued, and zero to the one that did not", async () => {
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = runUnderVerifyChainSemaphoreTimed(async () => { await firstHeld; }, "first");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(verifyChainSemaphoreActive()).toBe(1);

    // Queued behind the holder.
    const second = runUnderVerifyChainSemaphoreTimed(async () => "second", "second");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(verifyChainSemaphoreQueueLength()).toBe(1);

    releaseFirst();
    const [firstRes, secondRes] = await Promise.all([first, second]);

    // The holder never waited; the queued one did, and gets its OWN wait rather than a
    // shared "most recent wait" that whoever acquired last would have overwritten.
    expect(firstRes.queueWaitMs).toBe(0);
    expect(secondRes.queueWaitMs).toBeGreaterThan(0);
    expect(secondRes.result).toBe("second");
  });

  it("still releases the slot (and reports a wait) when the queued chain throws", async () => {
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = runUnderVerifyChainSemaphore(async () => { await firstHeld; });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = runUnderVerifyChainSemaphoreTimed(async () => { throw new Error("boom"); }, "second");
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirst();

    await expect(second).rejects.toThrow("boom");
    await first;
    // A failing queued chain must not wedge the queue's accounting.
    expect(verifyChainSemaphoreActive()).toBe(0);
    expect(verifyChainSemaphoreQueueLength()).toBe(0);
  });
});

/**
 * #957 — the semaphore above is in-process module state, so a builder agent's own `pnpm
 * test:mine`, a worktree dev server and a second board process were all invisible to it. Every
 * acquisition now also takes the cross-process MACHINE lock, and a chain that could not get it
 * reports a note the gate puts in its tier message.
 */
describe("verify-chain-semaphore + the machine lock (#957)", () => {
  let lockDir: string;

  beforeEach(() => {
    resetVerifyChainSemaphoreForTests();
    lockDir = mkdtempSync(join(tmpdir(), "ak-chain-lock-"));
    process.env[MACHINE_LOCK_DIR_ENV] = lockDir;
  });
  afterEach(() => {
    resetVerifyChainSemaphoreForTests();
    delete process.env[MACHINE_LOCK_ENV];
    delete process.env[MACHINE_LOCK_DIR_ENV];
    rmSync(lockDir, { recursive: true, force: true });
  });

  it("with the lock OFF (the default) nothing changes and no lockfile is written", async () => {
    const { result, lockNote } = await runUnderVerifyChainSemaphoreTimed(async () => "done", "chain");
    expect(result).toBe("done");
    expect(lockNote).toBeNull();
    expect(existsSync(machineVerifyLockPath())).toBe(false);
  });

  it("with the lock ON, a chain HOLDS it while running — a foreign process would be blocked", async () => {
    process.env[MACHINE_LOCK_ENV] = "1";
    let heldDuring = false;
    await runUnderVerifyChainSemaphore(async () => {
      heldDuring = existsSync(machineVerifyLockPath());
    }, "chain");
    expect(heldDuring).toBe(true);
    // ...and it is released afterwards, so the next verifier on the box gets in.
    expect(existsSync(machineVerifyLockPath())).toBe(false);
  });

  it("WAITS for a live foreign holder rather than running beside it — released, it proceeds", async () => {
    process.env[MACHINE_LOCK_ENV] = "1";
    // A live foreign holder: our own pid, so the liveness probe says "alive" and the lock is
    // never reclaimed out from under it. This stands in for the builder / worktree dev server /
    // second board process that #949's in-process semaphore could not see.
    const foreign = {
      pid: process.pid,
      hostname: hostname(),
      role: "builder-test",
      holder: "a builder's own pnpm test:mine",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    writeFileSync(machineVerifyLockPath(), JSON.stringify(foreign));

    let entered = false;
    const chain = runUnderVerifyChainSemaphore(async () => { entered = true; }, "my gate");

    // While the foreign holder is there, the chain must NOT be running. This is the whole
    // ticket: before #957 it would have started immediately, because the foreign process is not
    // in this event loop and the in-process semaphore is blind to it.
    await new Promise((r) => setTimeout(r, 50));
    expect(entered).toBe(false);

    // The foreign process finishes and releases.
    rmSync(machineVerifyLockPath(), { force: true });
    await chain;
    expect(entered).toBe(true);
  }, 20_000);
});
