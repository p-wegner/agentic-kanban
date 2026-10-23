/**
 * #1681: a red rc sweep on a sha that already swept green is "flaky under load" — no heal ticket
 * before one idle re-run — and a rc sweep yields to a running merge gate unless a second worker is free.
 */
import { describe, expect, it, vi } from "vitest";
import { reconcileRcSweep } from "../services/rc-heal-ticket.service.js";
import { decideVerifyPlacement, type VerifyWorkerCandidate } from "../services/verify-placement.js";

const worker = (name: string): VerifyWorkerCandidate => ({ id: name, name, freeSlots: 1 });
const place = (workers: VerifyWorkerCandidate[], gateActive: boolean, kind: "rc-sweep" | "train-gate" = "rc-sweep") =>
  decideVerifyPlacement({ placement: "worker", kind, hostHeld: false, allowlist: new Set(workers.map((w) => w.name)), workers, gateActive });

describe("rc flaky re-run (#1681)", () => {
  it("files no heal ticket for the first red on a sha with a prior green sweep", async () => {
    const createIssue = vi.fn();
    const r = await reconcileRcSweep({ projectId: "p", rcBranch: "rc/1", sha: "abc1234", outcome: "red", failedSuites: ["a"], flakeRerunOwed: true, createIssue } as never);
    expect(r.action).toBe("deferred_rerun");
    expect(r.reason).toMatch(/flaky under load/);
    expect(createIssue).not.toHaveBeenCalled();
  });
});

describe("rc sweep yields to merge gates (#1681)", () => {
  it("holds a queued rc sweep while a gate runs and only one worker is eligible", () => {
    expect(place([worker("a")], true).target).toBe("hold");
  });
  it("places it when a second worker would otherwise idle, or no gate is running", () => {
    expect(place([worker("a"), worker("b")], true).target).toBe("worker");
    expect(place([worker("a")], false).target).toBe("worker");
  });
  it("never holds the gate itself", () => {
    expect(place([worker("a")], true, "train-gate").target).toBe("worker");
  });
});
