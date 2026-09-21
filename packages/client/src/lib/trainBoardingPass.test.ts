import { describe, expect, it } from "vitest";
import { deriveTrainBoardingPass, type TrainBoardingPassSource } from "./trainBoardingPass.js";

const NOW = Date.parse("2026-01-01T00:20:00.000Z");

function source(overrides: Partial<TrainBoardingPassSource>): TrainBoardingPassSource {
  return {
    trainId: "train-1",
    label: "q1a2b3",
    carPosition: 2,
    memberCount: 4,
    phase: "gating",
    boardedAt: "2026-01-01T00:00:00.000Z",
    outcome: null,
    ...overrides,
  };
}

describe("deriveTrainBoardingPass", () => {
  it("returns null when there is no train to show", () => {
    expect(deriveTrainBoardingPass(null)).toBeNull();
    expect(deriveTrainBoardingPass(undefined)).toBeNull();
  });

  it.each([
    ["assembling", "Train q1a2b3 · car 2/4 · assembling · 20m"],
    ["gating", "Train q1a2b3 · car 2/4 · gating · 20m"],
    ["landing", "Train q1a2b3 · car 2/4 · landing · 20m"],
  ] as const)("renders an in-flight %s phase chip", (phase, expectedLabel) => {
    const pass = deriveTrainBoardingPass(source({ phase }), NOW);
    expect(pass?.label).toBe(expectedLabel);
    expect(pass?.tooltip).toContain(phase);
    expect(pass?.tooltip).toContain("20m");
  });

  it("defaults to assembling when phase is null (just boarded)", () => {
    const pass = deriveTrainBoardingPass(source({ phase: null, boardedAt: "2026-01-01T00:19:30.000Z" }), NOW);
    expect(pass?.label).toBe("Train q1a2b3 · car 2/4 · assembling · 30s");
  });

  it("renders 'landed with #N #M' when the run landed alongside co-members", () => {
    const pass = deriveTrainBoardingPass(
      source({ outcome: { kind: "landed", withIssueNumbers: [1176, 1177] } }),
      NOW,
    );
    expect(pass?.label).toBe("Train q1a2b3 · car 2/4 · landed with #1176 #1177");
    expect(pass?.tooltip).toContain("#1176");
    expect(pass?.tooltip).toContain("#1177");
  });

  it("renders a bare 'landed' when it landed alone", () => {
    const pass = deriveTrainBoardingPass(source({ outcome: { kind: "landed", withIssueNumbers: [] } }), NOW);
    expect(pass?.label).toBe("Train q1a2b3 · car 2/4 · landed");
  });

  it("renders the drop reason", () => {
    const pass = deriveTrainBoardingPass(
      source({ outcome: { kind: "dropped", reason: "conflict in packages/server/src/foo.ts" } }),
      NOW,
    );
    expect(pass?.label).toBe("Train q1a2b3 · car 2/4 · dropped: conflict in packages/server/src/foo.ts");
    expect(pass?.tooltip).toContain("Dropped from the train");
  });

  it("renders 'bisected out' with the gate failure in the tooltip", () => {
    const pass = deriveTrainBoardingPass(
      source({ outcome: { kind: "bisected-out", reason: "type error in foo.ts" } }),
      NOW,
    );
    expect(pass?.label).toBe("Train q1a2b3 · car 2/4 · bisected out");
    expect(pass?.tooltip).toContain("Bisected out");
    expect(pass?.tooltip).toContain("type error in foo.ts");
  });

  it("renders 'unresolved' for a batch failure never attributed to this member", () => {
    const pass = deriveTrainBoardingPass(source({ outcome: { kind: "unresolved" } }), NOW);
    expect(pass?.label).toBe("Train q1a2b3 · car 2/4 · unresolved");
  });
});
