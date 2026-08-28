import { describe, it, expect } from "vitest";
import { resolveRedDebtGateVerdict, isRedSetSubsetOfLedger } from "../lib/red-debt-gate.js";

describe("isRedSetSubsetOfLedger", () => {
  it("is true for an empty failing set regardless of ledger", () => {
    expect(isRedSetSubsetOfLedger([], [])).toBe(true);
    expect(isRedSetSubsetOfLedger([], ["a"])).toBe(true);
  });

  it("is true only when every failing suite is ledgered", () => {
    expect(isRedSetSubsetOfLedger(["a", "b"], ["a", "b", "c"])).toBe(true);
    expect(isRedSetSubsetOfLedger(["a", "b"], ["a"])).toBe(false);
  });
});

describe("resolveRedDebtGateVerdict — acceptance: known-red no longer blocks fast, new red still does", () => {
  it("no-failures when nothing failed", () => {
    expect(resolveRedDebtGateVerdict({ failedSuites: [], ledger: [], posture: "fast" })).toEqual({ outcome: "no-failures" });
  });

  it("PASS-WITH-DEBT under fast when the failing set is a subset of the ledger, naming the debt", () => {
    const verdict = resolveRedDebtGateVerdict({
      failedSuites: ["server/foo.test.ts"],
      ledger: [{ suite: "server/foo.test.ts", tag: "real" }],
      posture: "fast",
    });
    expect(verdict.outcome).toBe("pass-with-debt");
    if (verdict.outcome !== "pass-with-debt") throw new Error("unreachable");
    expect(verdict.carriedDebt).toEqual(["server/foo.test.ts"]);
    expect(verdict.message).toContain("server/foo.test.ts");
  });

  it("REJECTED under fast when a NEW suite fails, naming the member", () => {
    const verdict = resolveRedDebtGateVerdict({
      failedSuites: ["server/foo.test.ts", "server/new-breakage.test.ts"],
      ledger: [{ suite: "server/foo.test.ts", tag: "real" }],
      posture: "fast",
    });
    expect(verdict.outcome).toBe("rejected");
    if (verdict.outcome !== "rejected") throw new Error("unreachable");
    expect(verdict.newRed).toEqual(["server/new-breakage.test.ts"]);
    expect(verdict.message).toContain("server/new-breakage.test.ts");
    // Still names the debt it ALSO carried, even though the overall verdict is a rejection.
    expect(verdict.message).toContain("server/foo.test.ts");
  });

  it("REJECTED under fast for an entirely new suite with no ledger at all", () => {
    const verdict = resolveRedDebtGateVerdict({
      failedSuites: ["server/new.test.ts"],
      ledger: [],
      posture: "fast",
    });
    expect(verdict.outcome).toBe("rejected");
  });

  it("PASS-WITH-NEW-DEBT under sprint: new red is ledgered rather than rejected", () => {
    const verdict = resolveRedDebtGateVerdict({
      failedSuites: ["server/foo.test.ts", "server/new-breakage.test.ts"],
      ledger: [{ suite: "server/foo.test.ts", tag: "real" }],
      posture: "sprint",
    });
    expect(verdict.outcome).toBe("pass-with-new-debt");
    if (verdict.outcome !== "pass-with-new-debt") throw new Error("unreachable");
    expect(verdict.newRed).toEqual(["server/new-breakage.test.ts"]);
    expect(verdict.carriedDebt).toEqual(["server/foo.test.ts"]);
    expect(verdict.message).toContain("server/new-breakage.test.ts");
  });

  it("sprint still reports pass-with-debt (not pass-with-new-debt) when nothing is new", () => {
    const verdict = resolveRedDebtGateVerdict({
      failedSuites: ["server/foo.test.ts"],
      ledger: [{ suite: "server/foo.test.ts", tag: "flaky" }],
      posture: "sprint",
    });
    expect(verdict.outcome).toBe("pass-with-debt");
  });
});
