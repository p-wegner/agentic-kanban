import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./helpers/test-db.js";
import { resolveVerifyMaxWorkers } from "../services/verify-tunables.js";
import {
  resetVerifyChainSemaphoreForTests,
  runUnderVerifyChainSemaphore,
  verifyChainMaxSlots,
} from "../services/verify-chain-semaphore.js";

/**
 * #1160 — the per-chain worker count and the verify-chain slot count come from ONE budget.
 *
 * The danger the ticket names: two concurrent gates each reading "host is idle" and each taking
 * the whole core budget, so that together they run at 2x what one gate alone was ever allowed —
 * the #903 contention re-created by the very change meant to lift its cap. The guard is that
 * `resolveVerifyMaxWorkers` divides its CPU share by `verifyChainMaxSlots()`, the same partition
 * the semaphore admits against, and the sum of every slot's share is bounded by construction.
 *
 * These tests pin the seam between the two modules; the arithmetic itself is pinned in
 * `packages/shared/__tests__/machine-capacity.test.ts`. RAM is read live from the real box
 * here, so only the CPU-side claim is asserted exactly.
 */
describe("the gate's worker budget is partitioned by the verify-chain slot count (#1160)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
    delete process.env.KANBAN_VERIFY_MAX_WORKERS;
    delete process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY;
  });
  afterEach(() => {
    resetVerifyChainSemaphoreForTests();
    delete process.env.KANBAN_VERIFY_MAX_WORKERS;
    delete process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY;
    delete process.env.SMART_HOOKS_FORCE;
  });

  it("reports the partition it divided by, and the chains in flight INCLUDING the caller's own", async () => {
    resetVerifyChainSemaphoreForTests({ capacity: { cpuCount: 16, freeGb: 20 } });
    expect(verifyChainMaxSlots()).toBe(3);

    const seen = await runUnderVerifyChainSemaphore(
      () => resolveVerifyMaxWorkers("project-a", db),
      "gate under test",
    );
    expect(seen.derived).toBe(true);
    expect(seen.chainSlots).toBe(3);
    expect(seen.chainsInFlight).toBe(1);
  });

  it("N concurrent chains' shares together never exceed one unpartitioned chain's CPU budget", async () => {
    // The partition must be derived from the SAME core count the share is — the real box's —
    // or a 4-core CI runner would partition 16 cores' worth of slots over its own 2-core budget.
    resetVerifyChainSemaphoreForTests({ capacity: { cpuCount: os.cpus().length, freeGb: 20 } });
    // `SMART_HOOKS_FORCE=1` makes `readTier0Capacity` report free RAM as unreadable, which turns
    // the RAM budget into the CPU budget: the claim under test is the CPU partition, and the live
    // RAM of whatever box runs this suite must not decide it either way.
    process.env.SMART_HOOKS_FORCE = "1";
    const slots = verifyChainMaxSlots();

    // What a lone chain was allowed before #1160: the whole `cpus-2` budget.
    process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY = "1";
    const whole = (await resolveVerifyMaxWorkers("project-a", db)).workers;
    delete process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY;

    const shares = await Promise.all(
      Array.from({ length: slots }, (_, i) =>
        runUnderVerifyChainSemaphore(async () => (await resolveVerifyMaxWorkers("project-a", db)).workers, `chain-${i}`),
      ),
    );
    expect(shares).toHaveLength(slots);
    expect(shares.reduce((sum, w) => sum + w, 0)).toBeLessThanOrEqual(whole);
  });

  it("an env-pinned worker count reports no partition — it was not derived from one", async () => {
    process.env.KANBAN_VERIFY_MAX_WORKERS = "5";
    const pinned = await resolveVerifyMaxWorkers("project-a", db);
    expect(pinned).toMatchObject({ workers: 5, derived: false, chainSlots: null, chainsInFlight: null });
  });

  it("a serial pin (KANBAN_VERIFY_CHAIN_CONCURRENCY=1) hands the lone chain the whole budget again", async () => {
    resetVerifyChainSemaphoreForTests({ capacity: { cpuCount: 16, freeGb: 20 } });
    process.env.KANBAN_VERIFY_CHAIN_CONCURRENCY = "1";
    const seen = await resolveVerifyMaxWorkers("project-a", db);
    expect(seen.chainSlots).toBe(1);
  });
});
