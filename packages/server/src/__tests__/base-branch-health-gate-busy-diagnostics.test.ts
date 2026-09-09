/**
 * #1084 — `POST /base-branch-health/reprobe` returning `{skippedReason:"gate_running"}` gave no
 * way to see WHO holds the slot or for how long, so distinguishing "legitimately busy" from
 * "stuck" required reading source (and the inference was still wrong in the incident that filed
 * this ticket). `describeGateBusy()` is the fix: it names the source (in-process semaphore vs.
 * the cross-process machine lock), the holder count, and the oldest holder's age.
 */
import { describe, it, expect, afterEach } from "vitest";
import { runUnderBuildSemaphore, buildSemaphoreActive } from "../services/jvm-build-semaphore.js";
import { describeGateBusy } from "../services/base-branch-health-reprobe.service.js";

afterEach(() => {
  delete process.env.KANBAN_VERIFY_CONCURRENCY;
});

describe("describeGateBusy (#1084)", () => {
  it("reports not busy, with no source, when nothing holds the semaphore or the machine lock", () => {
    expect(buildSemaphoreActive()).toBe(0); // sanity: no leaked state from another test
    const diag = describeGateBusy();
    expect(diag).toEqual({
      busy: false,
      source: null,
      semaphoreActive: 0,
      semaphoreOldestActiveAgeMs: null,
      machineLockHolder: null,
    });
  });

  it("names the in-process semaphore as the source, with a holder count and a non-null age, while a task is running", async () => {
    process.env.KANBAN_VERIFY_CONCURRENCY = "1";
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const task = runUnderBuildSemaphore(async () => {
      await gate;
    });

    // Let the task actually acquire the slot before inspecting.
    await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 5)); // give the age a moment to be measurably > 0

    const diag = describeGateBusy();
    expect(diag.busy).toBe(true);
    expect(diag.source).toBe("semaphore");
    expect(diag.semaphoreActive).toBe(1);
    expect(diag.semaphoreOldestActiveAgeMs).not.toBeNull();
    expect(diag.semaphoreOldestActiveAgeMs!).toBeGreaterThanOrEqual(0);
    expect(diag.machineLockHolder).toBeNull();

    release();
    await task;
    expect(describeGateBusy().busy).toBe(false);
  });

  it("clears back to not-busy once the holding task settles, even after throwing (no leaked diagnostics)", async () => {
    process.env.KANBAN_VERIFY_CONCURRENCY = "1";
    await expect(runUnderBuildSemaphore(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const diag = describeGateBusy();
    expect(diag.busy).toBe(false);
    expect(diag.semaphoreActive).toBe(0);
    expect(diag.semaphoreOldestActiveAgeMs).toBeNull();
  });
});
