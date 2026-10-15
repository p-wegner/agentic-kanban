import { describe, it, expect } from "vitest";
import { createSetupSlots, resolveSetupSlots } from "../worker/worker-setup-slots.js";

describe("worker setup slots (#1499)", () => {
  it("runs setups one at a time by default", async () => {
    const slots = createSetupSlots(1);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    };
    await Promise.all([slots.run(task), slots.run(task), slots.run(task)]);
    expect(peak).toBe(1);
  });

  it("honours a larger limit and releases the slot on failure", async () => {
    const slots = createSetupSlots(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    };
    await Promise.all([slots.run(task), slots.run(task), slots.run(task)]);
    expect(peak).toBe(2);
    await expect(slots.run(async () => { throw new Error("x"); })).rejects.toThrow("x");
    await expect(slots.run(async () => "ok")).resolves.toBe("ok");
  });

  it("reads KANBAN_WORKER_SETUP_CONCURRENCY, falling back to 1", () => {
    expect(resolveSetupSlots({ KANBAN_WORKER_SETUP_CONCURRENCY: "3" })).toBe(3);
    expect(resolveSetupSlots({ KANBAN_WORKER_SETUP_CONCURRENCY: "0" })).toBe(1);
    expect(resolveSetupSlots({})).toBe(1);
  });
});
