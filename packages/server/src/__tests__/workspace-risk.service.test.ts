import { describe, it, expect } from "vitest";
import { scoreWorkspaceRisk } from "../services/workspace-risk.service.js";

// Fixed "now" so tests don't age out
const NOW_MS = new Date("2026-06-03T12:00:00.000Z").getTime();
const hoursAgo = (h: number) => new Date(NOW_MS - h * 60 * 60 * 1000).toISOString();

describe("scoreWorkspaceRisk", () => {
  it("returns none risk for a clean, fresh workspace", () => {
    const result = scoreWorkspaceRisk({
      workspaceStatus: "active",
      lastSessionAt: hoursAgo(0.5),
      sessionStatus: "running",
      diffStats: null,
      conflicts: null,
      recentFailureCount: 0,
      pendingQuestionCount: 0,
      overlapFileCount: 0,
      nowMs: NOW_MS,
    });
    expect(result.riskLevel).toBe("none");
    expect(result.riskScore).toBe(0);
    expect(result.signals).toHaveLength(0);
  });

  it("flags high-severity merge conflicts", () => {
    const result = scoreWorkspaceRisk({
      workspaceStatus: "idle",
      lastSessionAt: hoursAgo(1),
      sessionStatus: "stopped",
      diffStats: { filesChanged: 3, insertions: 10, deletions: 5 },
      conflicts: { hasConflicts: true, conflictingFiles: ["src/a.ts", "src/b.ts"] },
      recentFailureCount: 0,
      pendingQuestionCount: 0,
      overlapFileCount: 0,
      nowMs: NOW_MS,
    });
    // conflicts alone contribute score 4 → medium (threshold: high=6, medium=3)
    expect(result.riskLevel).toBe("medium");
    const conflictSignal = result.signals.find((s) => s.key === "conflicts");
    expect(conflictSignal).toBeDefined();
    expect(conflictSignal?.severity).toBe("high");
    expect(conflictSignal?.value).toBe(2);
  });

  it("produces medium risk for a 2-hour stale session", () => {
    const result = scoreWorkspaceRisk({
      workspaceStatus: "active",
      lastSessionAt: hoursAgo(2.5),
      sessionStatus: "running",
      diffStats: null,
      conflicts: null,
      recentFailureCount: 0,
      pendingQuestionCount: 0,
      overlapFileCount: 0,
      nowMs: NOW_MS,
    });
    expect(result.riskLevel).toBe("low");
    const ageSignal = result.signals.find((s) => s.key === "age");
    expect(ageSignal).toBeDefined();
    expect(ageSignal?.severity).toBe("medium");
  });

  it("produces high risk for a 5-hour stale session", () => {
    const result = scoreWorkspaceRisk({
      workspaceStatus: "active",
      lastSessionAt: hoursAgo(5),
      sessionStatus: "running",
      diffStats: null,
      conflicts: null,
      recentFailureCount: 0,
      pendingQuestionCount: 0,
      overlapFileCount: 0,
      nowMs: NOW_MS,
    });
    const ageSignal = result.signals.find((s) => s.key === "age");
    expect(ageSignal?.severity).toBe("high");
  });

  it("scores large diff as medium uncommitted signal", () => {
    const result = scoreWorkspaceRisk({
      workspaceStatus: "idle",
      lastSessionAt: hoursAgo(0.5),
      sessionStatus: "stopped",
      diffStats: { filesChanged: 8, insertions: 50, deletions: 20 },
      conflicts: null,
      recentFailureCount: 0,
      pendingQuestionCount: 0,
      overlapFileCount: 0,
      nowMs: NOW_MS,
    });
    const uncommittedSignal = result.signals.find((s) => s.key === "uncommitted");
    expect(uncommittedSignal).toBeDefined();
    expect(uncommittedSignal?.severity).toBe("medium");
    expect(result.riskLevel).toBe("low");
  });

  it("scores very large diff (20+ files) as high severity", () => {
    const result = scoreWorkspaceRisk({
      workspaceStatus: "idle",
      lastSessionAt: hoursAgo(0.5),
      sessionStatus: "stopped",
      diffStats: { filesChanged: 25, insertions: 200, deletions: 50 },
      conflicts: null,
      recentFailureCount: 0,
      pendingQuestionCount: 0,
      overlapFileCount: 0,
      nowMs: NOW_MS,
    });
    const uncommittedSignal = result.signals.find((s) => s.key === "uncommitted");
    expect(uncommittedSignal?.severity).toBe("high");
  });

  it("scores small diff (< 5 files) as low severity with no score contribution", () => {
    const result = scoreWorkspaceRisk({
      workspaceStatus: "idle",
      lastSessionAt: hoursAgo(0.5),
      sessionStatus: "stopped",
      diffStats: { filesChanged: 2, insertions: 10, deletions: 3 },
      conflicts: null,
      recentFailureCount: 0,
      pendingQuestionCount: 0,
      overlapFileCount: 0,
      nowMs: NOW_MS,
    });
    const uncommittedSignal = result.signals.find((s) => s.key === "uncommitted");
    expect(uncommittedSignal?.severity).toBe("low");
    // Small diff doesn't contribute to score
    expect(result.riskScore).toBe(0);
  });

  it("flags high risk for 3+ recent launch failures", () => {
    const result = scoreWorkspaceRisk({
      workspaceStatus: "idle",
      lastSessionAt: hoursAgo(1),
      sessionStatus: "stopped",
      diffStats: null,
      conflicts: null,
      recentFailureCount: 4,
      pendingQuestionCount: 0,
      overlapFileCount: 0,
      nowMs: NOW_MS,
    });
    const failureSignal = result.signals.find((s) => s.key === "failures");
    expect(failureSignal?.severity).toBe("high");
    expect(failureSignal?.value).toBe(4);
  });

  it("flags medium risk for 1-2 launch failures", () => {
    const result = scoreWorkspaceRisk({
      workspaceStatus: "idle",
      lastSessionAt: hoursAgo(1),
      sessionStatus: "stopped",
      diffStats: null,
      conflicts: null,
      recentFailureCount: 2,
      pendingQuestionCount: 0,
      overlapFileCount: 0,
      nowMs: NOW_MS,
    });
    const failureSignal = result.signals.find((s) => s.key === "failures");
    expect(failureSignal?.severity).toBe("medium");
  });

  it("flags pending questions as high severity", () => {
    const result = scoreWorkspaceRisk({
      workspaceStatus: "active",
      lastSessionAt: hoursAgo(0.2),
      sessionStatus: "running",
      diffStats: null,
      conflicts: null,
      recentFailureCount: 0,
      pendingQuestionCount: 2,
      overlapFileCount: 0,
      nowMs: NOW_MS,
    });
    const qSignal = result.signals.find((s) => s.key === "questions");
    expect(qSignal?.severity).toBe("high");
    expect(qSignal?.value).toBe(2);
  });

  it("flags medium overlap (2-4 files) as medium severity", () => {
    const result = scoreWorkspaceRisk({
      workspaceStatus: "active",
      lastSessionAt: hoursAgo(0.5),
      sessionStatus: "running",
      diffStats: null,
      conflicts: null,
      recentFailureCount: 0,
      pendingQuestionCount: 0,
      overlapFileCount: 3,
      nowMs: NOW_MS,
    });
    const overlapSignal = result.signals.find((s) => s.key === "overlap");
    expect(overlapSignal?.severity).toBe("medium");
  });

  it("flags high overlap (5+ files) as high severity", () => {
    const result = scoreWorkspaceRisk({
      workspaceStatus: "active",
      lastSessionAt: hoursAgo(0.5),
      sessionStatus: "running",
      diffStats: null,
      conflicts: null,
      recentFailureCount: 0,
      pendingQuestionCount: 0,
      overlapFileCount: 6,
      nowMs: NOW_MS,
    });
    const overlapSignal = result.signals.find((s) => s.key === "overlap");
    expect(overlapSignal?.severity).toBe("high");
  });

  it("flags single file overlap as low severity with no score contribution", () => {
    const result = scoreWorkspaceRisk({
      workspaceStatus: "active",
      lastSessionAt: hoursAgo(0.5),
      sessionStatus: "running",
      diffStats: null,
      conflicts: null,
      recentFailureCount: 0,
      pendingQuestionCount: 0,
      overlapFileCount: 1,
      nowMs: NOW_MS,
    });
    const overlapSignal = result.signals.find((s) => s.key === "overlap");
    expect(overlapSignal?.severity).toBe("low");
    // Single overlap doesn't contribute to score
    expect(result.riskScore).toBe(0);
  });

  it("accumulates score from multiple signals into high risk", () => {
    const result = scoreWorkspaceRisk({
      workspaceStatus: "idle",
      lastSessionAt: hoursAgo(5),
      sessionStatus: "stopped",
      diffStats: { filesChanged: 10, insertions: 60, deletions: 15 },
      conflicts: { hasConflicts: true, conflictingFiles: ["src/foo.ts"] },
      recentFailureCount: 3,
      pendingQuestionCount: 1,
      overlapFileCount: 5,
      nowMs: NOW_MS,
    });
    expect(result.riskLevel).toBe("high");
    // conflicts(4) + stale(3) + large-diff(1) + failures(3) + questions(2) + overlap(2) = 15
    expect(result.riskScore).toBeGreaterThanOrEqual(6);
  });

  it("returns empty signals for null/undefined inputs", () => {
    const result = scoreWorkspaceRisk({
      workspaceStatus: "idle",
      lastSessionAt: null,
      sessionStatus: null,
      diffStats: null,
      conflicts: null,
      recentFailureCount: 0,
      pendingQuestionCount: 0,
      overlapFileCount: 0,
      nowMs: NOW_MS,
    });
    expect(result.riskLevel).toBe("none");
    expect(result.riskScore).toBe(0);
    expect(result.signals).toHaveLength(0);
  });

  it("does not flag conflicts when conflicts.hasConflicts is false", () => {
    const result = scoreWorkspaceRisk({
      workspaceStatus: "idle",
      lastSessionAt: null,
      sessionStatus: null,
      diffStats: null,
      conflicts: { hasConflicts: false, conflictingFiles: [] },
      recentFailureCount: 0,
      pendingQuestionCount: 0,
      overlapFileCount: 0,
      nowMs: NOW_MS,
    });
    expect(result.signals.find((s) => s.key === "conflicts")).toBeUndefined();
  });
});
