import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseNextVerifyChainWaiter,
  resetVerifyChainSemaphoreForTests,
  runUnderVerifyChainSemaphore,
  runUnderVerifyChainSemaphoreTimed,
  verifyChainMaxSlots,
  verifyChainSemaphoreActive,
  verifyChainGateWaiting,
  verifyChainSemaphoreConcurrency,
  verifyChainSemaphoreQueueLength,
  type VerifyChainCapacityReading,
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

  it("derives concurrency 1 on a box with no room for a second chain (the #903 behaviour, now the tight-box case)", () => {
    // `resetVerifyChainSemaphoreForTests` installs the serial reading by default; the dynamic
    // path is exercised in the #1160 block below.
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
 * #1160 — the width is DERIVED from the box, not fixed at 1. A gate was measured waiting 7410s
 * behind another verification while the machine had cores and RAM idle; the fixed cap was the
 * bottleneck, not the suites. These tests drive the derivation through the capacity seam so the
 * box the suite runs on does not decide the outcome.
 */
describe("verify-chain-semaphore derives its width from live capacity (#1160)", () => {
  const roomy: VerifyChainCapacityReading = { cpuCount: 16, freeGb: 20 };   // 3 slots
  const twoWide: VerifyChainCapacityReading = { cpuCount: 16, freeGb: 9.4 }; // 2 slots (the measured box)
  const tight: VerifyChainCapacityReading = { cpuCount: 16, freeGb: 3 };    // 1 slot

  const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
  const held = () => {
    let release: () => void = () => {};
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release: () => release() };
  };

  beforeEach(() => {
    delete process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY;
  });
  afterEach(() => {
    resetVerifyChainSemaphoreForTests();
    delete process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY;
  });

  it("with plenty of free RAM, two chains run CONCURRENTLY and the third queues behind the CPU partition", async () => {
    resetVerifyChainSemaphoreForTests({ capacity: roomy });
    expect(verifyChainSemaphoreConcurrency()).toBe(3);

    const gates = [held(), held(), held(), held()];
    const started: number[] = [];
    const chains = gates.map((g, i) =>
      runUnderVerifyChainSemaphore(async () => { started.push(i); await g.promise; }, `chain-${i}`),
    );
    await tick();

    // Three admitted at once — the partition's maximum — and the fourth waits.
    expect(started).toEqual([0, 1, 2]);
    expect(verifyChainSemaphoreActive()).toBe(3);
    expect(verifyChainSemaphoreQueueLength()).toBe(1);

    gates[0]!.release();
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
    expect(verifyChainSemaphoreQueueLength()).toBe(0);

    gates.slice(1).forEach((g) => g.release());
    await Promise.all(chains);
    expect(verifyChainSemaphoreActive()).toBe(0);
  });

  it("with tight free RAM, the SAME box clamps back to one chain at a time", async () => {
    resetVerifyChainSemaphoreForTests({ capacity: tight });
    expect(verifyChainSemaphoreConcurrency()).toBe(1);

    const first = held();
    const order: string[] = [];
    const a = runUnderVerifyChainSemaphore(async () => { order.push("a-start"); await first.promise; order.push("a-end"); }, "a");
    await tick();
    const b = runUnderVerifyChainSemaphore(async () => { order.push("b-start"); }, "b");
    await tick();

    expect(order).toEqual(["a-start"]);
    expect(verifyChainSemaphoreQueueLength()).toBe(1);

    first.release();
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });

  it("re-reads the box at each admission, so a chain that consumed the headroom closes the door behind it", async () => {
    // The reading a live box would give: 9.4 GB free before anything runs (two slots), 4 GB once
    // the first chain's typecheck + tests are resident (no room for another). Modelled as a
    // reader that reports what is free NOW, which is what `os.freemem()` does.
    let freeGb = 9.4;
    resetVerifyChainSemaphoreForTests({ capacity: () => ({ cpuCount: 16, freeGb }) });
    expect(verifyChainSemaphoreConcurrency()).toBe(2);

    const first = held();
    const a = runUnderVerifyChainSemaphore(async () => { freeGb = 4; await first.promise; }, "a");
    await tick();
    expect(verifyChainSemaphoreActive()).toBe(1);

    // With 4 GB free and one chain running, `active + more that fit` is 1 + 0: b waits.
    let bRan = false;
    const b = runUnderVerifyChainSemaphore(async () => { bRan = true; }, "b");
    await tick();
    expect(bRan).toBe(false);
    expect(verifyChainSemaphoreQueueLength()).toBe(1);

    // a finishes and its RAM comes back: b is admitted on the release.
    freeGb = 9.4;
    first.release();
    await Promise.all([a, b]);
    expect(bRan).toBe(true);
  });

  it("admits a waiter without waiting for a release once free RAM opens a slot (the 30s re-check)", async () => {
    vi.useFakeTimers();
    try {
      let freeGb = 4; // one chain running would leave no room
      resetVerifyChainSemaphoreForTests({ capacity: () => ({ cpuCount: 16, freeGb }) });

      const first = held();
      const second = held();
      const a = runUnderVerifyChainSemaphore(async () => { await first.promise; }, "a");
      await vi.advanceTimersByTimeAsync(1);
      let bRan = false;
      const b = runUnderVerifyChainSemaphore(async () => { bRan = true; await second.promise; }, "b");
      await vi.advanceTimersByTimeAsync(1);
      expect(bRan).toBe(false);

      // A builder elsewhere on the box exits; nothing in this process released anything.
      freeGb = 9.4;
      await vi.advanceTimersByTimeAsync(31_000);
      expect(bRan).toBe(true);
      expect(verifyChainSemaphoreActive()).toBe(2);

      first.release();
      second.release();
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all([a, b]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a release admits AS MANY waiters as the box then has room for, not just one", async () => {
    resetVerifyChainSemaphoreForTests({ capacity: roomy });
    process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY = "1";
    const first = held();
    const a = runUnderVerifyChainSemaphore(async () => { await first.promise; }, "a");
    await tick();
    const started: string[] = [];
    const b = runUnderVerifyChainSemaphore(async () => { started.push("b"); }, "b");
    const c = runUnderVerifyChainSemaphore(async () => { started.push("c"); }, "c");
    await tick();
    expect(verifyChainSemaphoreQueueLength()).toBe(2);

    // The pin is lifted while both wait: the next release should let both through together.
    delete process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY;
    first.release();
    await tick();
    expect(started.sort()).toEqual(["b", "c"]);
    await Promise.all([a, b, c]);
  });

  it("KANBAN_VERIFY_CHAIN_CONCURRENCY pins the width in BOTH directions and becomes the partition", async () => {
    resetVerifyChainSemaphoreForTests({ capacity: roomy });
    process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY = "1";
    expect(verifyChainSemaphoreConcurrency()).toBe(1);
    expect(verifyChainMaxSlots()).toBe(1);

    resetVerifyChainSemaphoreForTests({ capacity: tight });
    process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY = "2";
    expect(verifyChainSemaphoreConcurrency()).toBe(2);
    expect(verifyChainMaxSlots()).toBe(2);
  });

  it("the partition is 1 under the cross-process machine lock — a mutex admits one chain whatever the box offers", () => {
    resetVerifyChainSemaphoreForTests({ capacity: roomy });
    process.env[MACHINE_LOCK_ENV] = "1";
    try {
      expect(verifyChainMaxSlots()).toBe(1);
    } finally {
      delete process.env[MACHINE_LOCK_ENV];
    }
    expect(verifyChainMaxSlots()).toBe(3);
  });

  it("the partition is the CPU-side maximum, stable across the RAM the box has right now", () => {
    resetVerifyChainSemaphoreForTests({ capacity: twoWide });
    // Two slots open right now by RAM, but every chain's worker share is divided by the
    // partition (3), so that if RAM later opens the third slot the three shares still fit.
    expect(verifyChainSemaphoreConcurrency()).toBe(2);
    expect(verifyChainMaxSlots()).toBe(3);
  });

  it("#978's priority order still holds within a wider semaphore: a gate is admitted before a background waiter", async () => {
    // Width 2 by PIN rather than by a static reading: a fixed 9.4 GB reader does not shrink as
    // chains start (a real `os.freemem()` does), so with two chains running it would still find
    // room for a third and nobody would queue. The property under test is the ORDER within a
    // wider semaphore, and the pin is the honest way to hold the width still.
    resetVerifyChainSemaphoreForTests({ capacity: twoWide });
    process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY = "2";
    const holders = [held(), held()];
    const a = runUnderVerifyChainSemaphore(async () => { await holders[0]!.promise; }, "a");
    const b = runUnderVerifyChainSemaphore(async () => { await holders[1]!.promise; }, "b");
    await tick();
    expect(verifyChainSemaphoreActive()).toBe(2);

    const admitted: string[] = [];
    const probe = runUnderVerifyChainSemaphore(async () => { admitted.push("probe"); }, "probe", undefined, undefined, { priority: "background" });
    const gate = runUnderVerifyChainSemaphore(async () => { admitted.push("gate"); }, "gate");
    await tick();
    expect(verifyChainGateWaiting()).toBe(true);

    // One slot frees: the gate takes it although the probe queued first. (The gate's chain is
    // instant, so its own release may already have admitted the probe by the time the tick
    // returns — the ORDER is the claim, not the count.)
    holders[0]!.release();
    await tick();
    expect(admitted[0]).toBe("gate");
    holders[1]!.release();
    await Promise.all([a, b, probe, gate]);
    expect(admitted).toEqual(["gate", "probe"]);
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
