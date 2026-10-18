import { describe, expect, it } from "vitest";
import { decideWorkerUpdates } from "../services/worker-auto-update.service.js";
import { rankVerifyWorkers } from "../services/verify-placement.js";

const stale = (v: string | undefined) => v === "old";

describe("decideWorkerUpdates (#1610)", () => {
  it("updates an idle stale online worker, makes a busy one wait, skips current/offline/pending", () => {
    const out = decideWorkerUpdates(
      [
        { id: "1", name: "idle", effectiveStatus: "online", workerVersion: "old", assignments: [] },
        { id: "2", name: "busy", effectiveStatus: "online", workerVersion: "old", assignments: [{}] },
        { id: "3", name: "verifying", effectiveStatus: "online", workerVersion: "old" },
        { id: "4", name: "current", effectiveStatus: "online", workerVersion: "new" },
        { id: "5", name: "offline", effectiveStatus: "offline", workerVersion: "old" },
        { id: "6", name: "pending", effectiveStatus: "online", workerVersion: "old", updateRequested: true },
      ],
      stale,
      new Set(["3"]),
    );
    expect(out.map((d) => [d.workerName, d.action])).toEqual([["idle", "update"], ["busy", "wait"], ["verifying", "wait"]]);
  });
});

describe("rankVerifyWorkers with a stale build (#1610)", () => {
  it("offers no train gate to a worker on an outdated build", () => {
    const ranked = rankVerifyWorkers(new Set(["a", "b"]), [
      { id: "a", name: "a", freeSlots: 1, buildStale: true },
      { id: "b", name: "b", freeSlots: 1 },
    ]);
    expect(ranked.map((w) => w.name)).toEqual(["b"]);
  });
});
