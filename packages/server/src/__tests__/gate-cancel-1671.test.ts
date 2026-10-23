import { describe, expect, it } from "vitest";
import { describeCancelledRefusal } from "../services/pre-merge-gate-placement.js";
import { recordVerifyGateOutcome } from "../services/test-impact-outcome.service.js";

describe("#1671 cancelled gate", () => {
  it("words a cancelled refusal as 'gate cancelled: <reason>', distinct from a worker refusal", () => {
    expect(describeCancelledRefusal("worker refused the job (cancelled): cancelled: the owner of this verify job stopped waiting"))
      .toBe("gate cancelled: the owner of this verify job stopped waiting");
    expect(describeCancelledRefusal("worker refused the job (sha_mismatch): wrong tree")).toBeNull();
  });

  it("records no test-impact row for a cancelled run", async () => {
    const logs: string[] = [];
    const res = await recordVerifyGateOutcome({
      workspaceId: "ws", workingDir: "/nonexistent", repoPath: null,
      outcome: { failure: { message: "x" }, failedSuites: [] }, tierInfo: null, cancelled: true, log: (m) => logs.push(m),
    });
    expect(res.recorded).toBe(false);
    expect(res.reason).toContain("cancelled");
  });
});
