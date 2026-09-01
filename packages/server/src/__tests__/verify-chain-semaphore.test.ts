import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseNextVerifyChainWaiter,
  resetVerifyChainSemaphoreForTests,
  runUnderVerifyChainSemaphore,
  runUnderVerifyChainSemaphoreTimed,
  verifyChainSemaphoreActive,
  verifyChainGateWaiting,
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

  it("reports the CROSS-PROCESS wait in queueWaitMs, not just the in-process one", async () => {
    process.env[MACHINE_LOCK_ENV] = "1";
    // The reported wait is what the gate's tier message says. The in-process semaphore reports
    // its OWN wait — 0 here, since nothing else is in this event loop — so passing the caller's
    // callback straight down would overwrite the machine-lock wait with that 0 and a gate that
    // queued behind ANOTHER PROCESS would report no wait at all. That silence is precisely what
    // the ticket forbids.
    const foreign = {
      pid: process.pid,
      hostname: hostname(),
      role: "builder-test",
      holder: "a builder's own pnpm test:mine",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    writeFileSync(machineVerifyLockPath(), JSON.stringify(foreign));

    const chain = runUnderVerifyChainSemaphoreTimed(async () => "done", "my gate");
    await new Promise((r) => setTimeout(r, 200));
    rmSync(machineVerifyLockPath(), { force: true });

    const { result, queueWaitMs } = await chain;
    expect(result).toBe("done");
    expect(queueWaitMs).toBeGreaterThan(0);
  }, 20_000);
});

describe("#978: a merge gate is admitted ahead of a background measurement", () => {
  const MIN = 60_000;
  const q = (priority: "gate" | "background", agoMin: number) => ({ priority, queuedAtMs: -agoMin * MIN });

  it("picks the first GATE waiter even when a background one arrived first", () => {
    // The observed case: #971's gate queued ~35 min behind a base-health probe. Both are
    // legitimate users of the one slot; only one has someone blocked behind it.
    const queue = [q("background", 5), q("gate", 3), q("gate", 1)];
    expect(chooseNextVerifyChainWaiter(queue, 0, 30 * MIN)).toBe(1);
  });

  it("keeps arrival order WITHIN the gate class", () => {
    expect(chooseNextVerifyChainWaiter([q("gate", 3), q("gate", 9)], 0, 30 * MIN)).toBe(0);
  });

  it("reverts to strict arrival order once a background waiter has been overtaken too long", () => {
    // Merges arrive in bursts here, so priority without a starvation bound is how the base's
    // health silently stops being measured — the failure the probe exists to prevent, reached
    // by optimising it.
    const queue = [q("background", 31), q("gate", 2)];
    expect(chooseNextVerifyChainWaiter(queue, 0, 30 * MIN)).toBe(0);
  });

  it("promotes on the OLDEST background waiter, not on the head of the queue", () => {
    const queue = [q("gate", 4), q("background", 45), q("gate", 1)];
    expect(chooseNextVerifyChainWaiter(queue, 0, 30 * MIN)).toBe(0);
  });

  it("takes the head when nothing is a gate", () => {
    expect(chooseNextVerifyChainWaiter([q("background", 5), q("background", 2)], 0, 30 * MIN)).toBe(0);
  });

  it("reports -1 for an empty queue", () => {
    expect(chooseNextVerifyChainWaiter([], 0, 30 * MIN)).toBe(-1);
  });

  it("takes a background waiter when it is the only one, even alongside a running chain", () => {
    expect(chooseNextVerifyChainWaiter([q("background", 1)], 0, 30 * MIN)).toBe(0);
  });

  it("`gate` is the default, so an existing caller's behaviour is unchanged", async () => {
    // Every pre-#978 call site omits the option. If the default were `background`, the first
    // opt-in would silently demote all of them.
    resetVerifyChainSemaphoreForTests();
    const order: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const first = runUnderVerifyChainSemaphore(
      () => new Promise<void>((resolve) => { releaseFirst = () => { order.push("first"); resolve(); }; }),
      "first",
    );
    await new Promise((r) => setTimeout(r, 0));
    const second = runUnderVerifyChainSemaphore(async () => { order.push("second"); }, "second");
    const third = runUnderVerifyChainSemaphore(async () => { order.push("third"); }, "third");
    await new Promise((r) => setTimeout(r, 0));
    releaseFirst!();
    await Promise.all([first, second, third]);

    expect(order).toEqual(["first", "second", "third"]);
  });
});

/**
 * #989 — the running holder must be able to ASK whether someone is blocked behind it.
 *
 * #978's classes act only at admission. A background probe already running holds the slot for up
 * to clone 5m + install 15m + verify 45m, so a gate arriving a minute in waits it out — the other
 * half of the ~35 minutes measured on #971's merge. This predicate is what the probe checks at
 * its stage boundaries.
 */
describe("#989: verifyChainGateWaiting exposes a queued gate to the running holder", () => {
  beforeEach(() => {
    resetVerifyChainSemaphoreForTests();
    delete process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY;
  });
  afterEach(() => {
    resetVerifyChainSemaphoreForTests();
    delete process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY;
  });

  it("is false with an empty queue", () => {
    expect(verifyChainGateWaiting()).toBe(false);
  });

  it("is true, FROM INSIDE the running chain, once a gate queues behind it", async () => {
    const seen: boolean[] = [];
    let releaseHolder: () => void = () => {};
    const held = new Promise<void>((resolve) => { releaseHolder = resolve; });

    const holder = runUnderVerifyChainSemaphore(async () => {
      // The probe's own checkpoint shape: read at a stage boundary, before and after a waiter
      // could have arrived.
      seen.push(verifyChainGateWaiting());
      await held;
      seen.push(verifyChainGateWaiting());
    }, "probe", undefined, undefined, { priority: "background" });

    await new Promise((r) => setTimeout(r, 10));
    const gate = runUnderVerifyChainSemaphore(async () => "landed", "gate");
    await new Promise((r) => setTimeout(r, 10));

    releaseHolder();
    await Promise.all([holder, gate]);

    // Nothing queued at the first checkpoint; a gate queued by the second.
    expect(seen).toEqual([false, true]);
  });

  it("is FALSE when only another background chain is queued — a probe does not yield to a probe", async () => {
    let releaseHolder: () => void = () => {};
    const held = new Promise<void>((resolve) => { releaseHolder = resolve; });
    let seenDuring: boolean | null = null;

    const holder = runUnderVerifyChainSemaphore(async () => {
      await held;
      seenDuring = verifyChainGateWaiting();
    }, "probe-a", undefined, undefined, { priority: "background" });

    await new Promise((r) => setTimeout(r, 10));
    const other = runUnderVerifyChainSemaphore(async () => "b", "probe-b", undefined, undefined, {
      priority: "background",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(verifyChainSemaphoreQueueLength()).toBe(1);

    releaseHolder();
    await Promise.all([holder, other]);
    expect(seenDuring).toBe(false);
  });

  it("goes back to false once the gate has been admitted", async () => {
    let releaseHolder: () => void = () => {};
    const held = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holder = runUnderVerifyChainSemaphore(async () => { await held; }, "probe", undefined, undefined, {
      priority: "background",
    });
    await new Promise((r) => setTimeout(r, 10));

    let waitingInsideGate: boolean | null = null;
    const gate = runUnderVerifyChainSemaphore(async () => {
      waitingInsideGate = verifyChainGateWaiting();
    }, "gate");
    await new Promise((r) => setTimeout(r, 10));
    expect(verifyChainGateWaiting()).toBe(true);

    releaseHolder();
    await Promise.all([holder, gate]);
    expect(waitingInsideGate).toBe(false);
    expect(verifyChainGateWaiting()).toBe(false);
  });
});
