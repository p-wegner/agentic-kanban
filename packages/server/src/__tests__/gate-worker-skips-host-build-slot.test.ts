import { describe, expect, it, vi } from "vitest";
import { runInHostBuildSlotUnlessOnWorker } from "../services/pre-merge-gate-placement.js";

describe("runInHostBuildSlotUnlessOnWorker (#1555)", () => {
  it("a worker-placed gate does not queue behind the host build semaphore", async () => {
    const hostSemaphore = vi.fn(() => new Promise<string>(() => {})); // held forever, like #1550
    const out = await runInHostBuildSlotUnlessOnWorker(() => Promise.resolve("x"), async () => "ran", hostSemaphore);
    expect(out).toBe("ran");
    expect(hostSemaphore).not.toHaveBeenCalled();
  });

  it("a host-placed gate still takes the host build semaphore", async () => {
    const hostSemaphore = vi.fn(async (task: () => Promise<string>) => task());
    const out = await runInHostBuildSlotUnlessOnWorker(undefined, async () => "ran", hostSemaphore);
    expect(out).toBe("ran");
    expect(hostSemaphore).toHaveBeenCalledOnce();
  });
});
