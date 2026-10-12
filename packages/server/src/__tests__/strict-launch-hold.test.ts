import { describe, it, expect, vi, beforeEach } from "vitest";

const readiness = vi.fn();
vi.mock("../services/worker-fleet.service.js", () => ({
  checkStrictLaunchReadiness: (...args: unknown[]) => readiness(...args),
}));

import { awaitStrictLaunchWorker, getLaunchHold, queuedReviewCount } from "../services/session-manager/strict-launch-hold.js";

const args = { database: {} as never, workspaceId: "ws-1", projectId: "p-1", providerName: "claude" as const };

describe("awaitStrictLaunchWorker (#1347)", () => {
  beforeEach(() => readiness.mockReset());

  it("holds while the worker drains, then proceeds when it is back", async () => {
    readiness
      .mockResolvedValueOnce({ kind: "hold", reason: "worker_updating", workerId: "w1" })
      .mockResolvedValueOnce({ kind: "hold", reason: "worker_reconnecting", workerId: "w1" })
      .mockResolvedValueOnce({ kind: "proceed" });
    const seen: Array<string | undefined> = [];
    await awaitStrictLaunchWorker(args, {
      sleep: async () => { seen.push(getLaunchHold("ws-1")?.reason); },
    });
    expect(seen).toEqual(["worker_updating", "worker_reconnecting"]);
    expect(getLaunchHold("ws-1")).toBeUndefined();
    expect(readiness).toHaveBeenCalledTimes(3);
  });

  it("refuses with NO_AVAILABLE_WORKER when nobody is eligible or about to be", async () => {
    readiness.mockResolvedValue({ kind: "refuse", reason: "no eligible claude worker and worker dispatch is strict" });
    await expect(awaitStrictLaunchWorker(args, { sleep: async () => {} })).rejects.toMatchObject({
      code: "CONFLICT",
      data: { code: "NO_AVAILABLE_WORKER" },
    });
  });

  it("fails as before once the hold times out, and clears the hold", async () => {
    readiness.mockResolvedValue({ kind: "hold", reason: "worker_updating", workerId: "w1" });
    await expect(
      awaitStrictLaunchWorker(args, { sleep: async () => {}, timeoutMs: 3000, pollMs: 1000 }),
    ).rejects.toMatchObject({ data: { code: "NO_AVAILABLE_WORKER", heldFor: "worker_updating" } });
    expect(getLaunchHold("ws-1")).toBeUndefined();
  });

  it("queues a review while every worker is full, and lets it through when a slot frees (#1411)", async () => {
    readiness
      .mockResolvedValueOnce({ kind: "hold", reason: "workers_busy", workerId: "w1" })
      .mockResolvedValueOnce({ kind: "hold", reason: "workers_busy", workerId: "w1" })
      .mockResolvedValueOnce({ kind: "proceed" });
    const seen: Array<string | undefined> = [];
    await awaitStrictLaunchWorker({ ...args, triggerType: "review" }, {
      sleep: async () => { seen.push(getLaunchHold("ws-1")?.reason); },
    });
    expect(seen).toEqual(["workers_busy", "workers_busy"]);
    expect(queuedReviewCount("p-1")).toBe(0);
  });

  it("a new builder waits behind a queued review even when a slot is free (#1411)", async () => {
    let builderDone = false;
    readiness.mockImplementation(async () => ({ kind: "hold", reason: "workers_busy", workerId: "w1" }));
    const review = awaitStrictLaunchWorker({ ...args, workspaceId: "ws-r", triggerType: "review" }, { sleep: async () => { await new Promise((r) => setTimeout(r, 1)); } });
    await new Promise((r) => setTimeout(r, 0));
    expect(queuedReviewCount("p-1")).toBe(1);
    readiness.mockImplementation(async () => ({ kind: "proceed" }));
    const builder = awaitStrictLaunchWorker({ ...args, workspaceId: "ws-b" }, { sleep: async () => { await new Promise((r) => setTimeout(r, 1)); } })
      .then(() => { builderDone = true; });
    await review;
    await builder;
    expect(builderDone).toBe(true);
    expect(queuedReviewCount("p-1")).toBe(0);
  });
});
