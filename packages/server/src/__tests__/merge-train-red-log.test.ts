import { describe, expect, it } from "vitest";
import { describeTrainGateRed } from "../services/merge-queue-train.js";

/**
 * A red train must say WHICH suites failed. MEASURED motivation: `train/2026-09-26-01` went red and
 * bisected with no log line naming the failing suites — the only trace was the control arm's
 * `gated the bare base … - green` later.
 */
describe("describeTrainGateRed", () => {
  const members = [
    { workspaceId: "db421ffc-0000", issueNumber: 1253 },
    { workspaceId: "aaaaaaaa-1111", issueNumber: 1261 },
    { workspaceId: "bbbbbbbb-2222", issueNumber: null },
  ];

  it("names the train, the members, the stage and the failing suite(s) for the whole train", () => {
    const line = describeTrainGateRed({
      label: "train/2026-09-26-01",
      attemptLabel: "train/2026-09-26-01",
      members,
      stage: "verify",
      failedSuites: ["packages/server/src/__tests__/codex-skills-parity.test.ts"],
      guardFailure: true,
      message: "failing suite(s): … long tail",
    });
    expect(line).toBe(
      "train/2026-09-26-01: train gate RED (whole train, 3 member(s): #1253, #1261, bbbbbbbb) - stage verify - " +
        "failing suite(s): packages/server/src/__tests__/codex-skills-parity.test.ts [deterministic guard failure]",
    );
  });

  it("marks a bisect half and falls back to the first message line when no suite could be named", () => {
    const line = describeTrainGateRed({
      label: "train/2026-09-26-01",
      attemptLabel: "train/2026-09-26-01a",
      members: members.slice(0, 1),
      stage: "setup",
      message: "\n  train staging worktree setup failed (exit 1)\nmore",
    });
    expect(line).toContain("(bisect attempt train/2026-09-26-01a, 1 member(s): #1253)");
    expect(line).toContain("stage setup - no failing suite could be named; train staging worktree setup failed (exit 1)");
  });
});
