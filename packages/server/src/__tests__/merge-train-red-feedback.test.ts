import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllGateRedFeedbackForTests } from "../services/gate-red-feedback.js";
import { attributeTrainRedToMembers, decideTrainRedFeedbackTargets, sendTrainRedFeedback, splitEnvironmentSuites } from "../services/merge-train-red-feedback.js";
import type { TrainRunResult } from "../services/merge-train.service.js";
import type { TrainMember } from "../services/merge-train-assembly.js";

const member = (id: string, changedFiles: string[]): TrainMember => ({ workspaceId: id, branch: `feature/${id}`, issueNumber: 1, changedFiles } as TrainMember);
const base = (over: Partial<TrainRunResult>): TrainRunResult => ({
  trainRef: "r", landed: [], dropped: [], gateRejected: [], sided: [], closeFailures: [], gateRuns: 1, attempts: [], ...over,
});

describe("red train builder feedback (#1298)", () => {
  beforeEach(() => resetAllGateRedFeedbackForTests());

  it("a bisected-out member with named suites gets exactly one turn, even across repeated sends", async () => {
    const a = member("a", ["x.test.ts"]);
    const b = member("b", []);
    const result = base({ gateRejected: [{ member: a, reason: "red", failedSuites: ["x.test.ts"] }], landed: [b] });
    const sendTurn = vi.fn().mockResolvedValue(undefined);
    const deps = { sendTurn, headSha: async () => "sha1" };
    await sendTrainRedFeedback(result, [a, b], deps);
    await sendTrainRedFeedback(result, [a, b], deps);
    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(sendTurn.mock.calls[0][0]).toBe("a");
    expect(sendTurn.mock.calls[0][1]).toContain("x.test.ts");
  });

  it("a rejected member with no named suite (infra class) gets no turn", async () => {
    const a = member("a", []);
    const sendTurn = vi.fn();
    await sendTrainRedFeedback(base({ gateRejected: [{ member: a, reason: "timeout" }] }), [a], { sendTurn, headSha: async () => null });
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("an agent-fix final-red train sends only the suite owners a turn", async () => {
    const a = member("a", ["x.test.ts"]);
    const b = member("b", ["y.ts"]);
    const result = base({ redStrategy: "agent-fix", gateFailure: "red", failedSuites: ["x.test.ts"] });
    const sendTurn = vi.fn().mockResolvedValue(undefined);
    await sendTrainRedFeedback(result, [a, b], { sendTurn, headSha: async () => "s" });
    expect(sendTurn.mock.calls.map((c) => c[0])).toEqual(["a"]);
  });

  it("an agent-fix final-red train with unattributable suites messages NO builder (#1569)", async () => {
    const a = member("a", ["p.ts"]);
    const b = member("b", ["q.ts"]);
    const result = base({ redStrategy: "agent-fix", gateFailure: "red", failedSuites: ["elsewhere.test.ts"] });
    const sendTurn = vi.fn().mockResolvedValue(undefined);
    await sendTrainRedFeedback(result, [a, b], { sendTurn, headSha: async () => "s" });
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("a red train outside agent-fix, with no rejection, sends nothing", () => {
    const a = member("a", ["x.test.ts"]);
    expect(decideTrainRedFeedbackTargets(base({ gateFailure: "red", failedSuites: ["x.test.ts"] }), [a])).toEqual([]);
  });

  it("attribution names nobody when none owns a suite", () => {
    const ms = [member("a", ["p"]), member("b", ["q"])];
    expect(attributeTrainRedToMembers(["z"], ms)).toHaveLength(0);
    expect(attributeTrainRedToMembers(["q"], ms).map((m) => m.workspaceId)).toEqual(["b"]);
  });
});

describe("ratchet output names the owner (#1573)", () => {
  const ratchetOut = "\u001b[31mFAIL\u001b[0m packages/server/src/__tests__/private-tree-walker-ratchet.test.ts\n  offender: packages/server/src/routes/preferences.ts\n";

  it("a ratchet failure naming a member's file attributes to that member only", () => {
    const a = member("a", ["packages/server/src/routes/preferences.ts"]);
    const b = member("b", ["other.ts"]);
    expect(attributeTrainRedToMembers(["packages/server/src/__tests__/private-tree-walker-ratchet.test.ts"], [a, b], ratchetOut).map((m) => m.workspaceId)).toEqual(["a"]);
  });

  it("environment failures have no owner and are not sent to members", () => {
    const a = member("a", ["p.ts"]);
    const out = "FAIL merge-train-orchestration.test.ts\n fatal: .git/config: Permission denied\nFAIL other.test.ts\n assertion failed";
    expect(splitEnvironmentSuites(["merge-train-orchestration.test.ts", "other.test.ts"], out))
      .toEqual({ environment: ["merge-train-orchestration.test.ts"], owned: ["other.test.ts"] });
    const result = base({ redStrategy: "agent-fix", gateFailure: out, failedSuites: ["merge-train-orchestration.test.ts"] });
    expect(decideTrainRedFeedbackTargets(result, [a])).toEqual([]);
  });
});
