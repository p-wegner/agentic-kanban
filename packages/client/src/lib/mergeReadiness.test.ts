import { describe, it, expect } from "vitest";
import {
  computeMergeReadiness,
  deriveActivity,
  deriveAgentBlocker,
  deriveReviewStatus,
  repoStatusFromCell,
  verdictSortRank,
  type RepoReadinessStatus,
} from "./mergeReadiness.js";

const clean = (label: string): RepoReadinessStatus => ({ label, kind: "clean", ahead: 0 });
const ahead = (label: string, n: number): RepoReadinessStatus => ({ label, kind: "ahead", ahead: n });
const conflicts = (label: string): RepoReadinessStatus => ({ label, kind: "conflicts", ahead: 3 });

describe("computeMergeReadiness", () => {
  it("is READY when work is ahead, reviewed, gate passed, and idle", () => {
    const v = computeMergeReadiness({
      repos: [ahead("api", 2), clean("web")],
      review: "approved",
      gate: "passed",
      activity: "idle",
    });
    expect(v).toEqual({ kind: "READY", reason: null });
  });

  it("BLOCKS on a repo conflict and names the repo", () => {
    const v = computeMergeReadiness({
      repos: [ahead("api", 1), conflicts("web")],
      review: "approved",
      gate: "failed",
      activity: "idle",
    });
    expect(v.kind).toBe("BLOCKED");
    expect(v.reason).toBe("conflicts in web");
  });

  it("summarizes many conflicting repos compactly", () => {
    const v = computeMergeReadiness({
      repos: [conflicts("a"), conflicts("b"), conflicts("c")],
      review: "approved",
      gate: "failed",
      activity: "idle",
    });
    expect(v.reason).toBe("conflicts in a, b +1");
  });

  it("BLOCKS with 'awaiting review' when work is ready but unreviewed", () => {
    const v = computeMergeReadiness({
      repos: [ahead("api", 4)],
      review: "pending",
      gate: "passed",
      activity: "idle",
    });
    expect(v).toEqual({ kind: "BLOCKED", reason: "awaiting review" });
  });

  it("BLOCKS with 'checks failed' when the gate fails without a repo conflict", () => {
    const v = computeMergeReadiness({
      repos: [ahead("api", 1)],
      review: "approved",
      gate: "failed",
      activity: "idle",
    });
    expect(v).toEqual({ kind: "BLOCKED", reason: "checks failed" });
  });

  it("BLOCKS on a hard agent blocker before checking review", () => {
    const v = computeMergeReadiness({
      repos: [ahead("api", 1)],
      review: "pending",
      gate: "passed",
      activity: "idle",
      agentBlocker: "agent error",
    });
    expect(v).toEqual({ kind: "BLOCKED", reason: "agent error" });
  });

  it("a conflict outranks the agent blocker", () => {
    const v = computeMergeReadiness({
      repos: [conflicts("web")],
      review: "pending",
      gate: "failed",
      activity: "idle",
      agentBlocker: "agent error",
    });
    expect(v.reason).toBe("conflicts in web");
  });

  it("is IN-PROGRESS while the agent is working", () => {
    const v = computeMergeReadiness({
      repos: [ahead("api", 1)],
      review: "pending",
      gate: "passed",
      activity: "working",
    });
    expect(v).toEqual({ kind: "IN-PROGRESS", reason: "agent working" });
  });

  it("is IN-PROGRESS while review is running", () => {
    const v = computeMergeReadiness({
      repos: [ahead("api", 1)],
      review: "in-progress",
      gate: "passed",
      activity: "idle",
    });
    expect(v).toEqual({ kind: "IN-PROGRESS", reason: "review running" });
  });

  it("is IN-PROGRESS with 'status unknown' when a repo status could not be read", () => {
    const v = computeMergeReadiness({
      repos: [{ label: "api", kind: "unknown", ahead: 0 }],
      review: "approved",
      gate: "none",
      activity: "idle",
    });
    expect(v).toEqual({ kind: "IN-PROGRESS", reason: "status unknown" });
  });

  it("is IN-PROGRESS with 'no changes yet' when nothing is ahead", () => {
    const v = computeMergeReadiness({
      repos: [clean("api"), clean("web")],
      review: "pending",
      gate: "none",
      activity: "idle",
    });
    expect(v).toEqual({ kind: "IN-PROGRESS", reason: "no changes yet" });
  });
});

describe("verdictSortRank", () => {
  it("orders READY before BLOCKED before IN-PROGRESS", () => {
    expect(verdictSortRank("READY")).toBeLessThan(verdictSortRank("BLOCKED"));
    expect(verdictSortRank("BLOCKED")).toBeLessThan(verdictSortRank("IN-PROGRESS"));
  });
});

describe("repoStatusFromCell", () => {
  it("maps a null cell to not-part-of", () => {
    expect(repoStatusFromCell("web", null)).toEqual({ label: "web", kind: "not-part-of", ahead: 0 });
  });
  it("maps merged and no-change to clean", () => {
    expect(repoStatusFromCell("api", { state: "merged", ahead: 0 }).kind).toBe("clean");
    expect(repoStatusFromCell("api", { state: "no-change", ahead: 0 }).kind).toBe("clean");
  });
  it("folds stranded into ahead, preserving the ahead count", () => {
    expect(repoStatusFromCell("api", { state: "stranded", ahead: 5 })).toEqual({ label: "api", kind: "ahead", ahead: 5 });
    expect(repoStatusFromCell("api", { state: "ahead", ahead: 2 })).toEqual({ label: "api", kind: "ahead", ahead: 2 });
  });
  it("maps conflict and unknown", () => {
    expect(repoStatusFromCell("api", { state: "conflict", ahead: 1 }).kind).toBe("conflicts");
    expect(repoStatusFromCell("api", { state: "unknown", ahead: 0 }).kind).toBe("unknown");
  });
});

describe("workspace-status derivations", () => {
  it("derives review status", () => {
    expect(deriveReviewStatus("ready_for_merge")).toBe("approved");
    expect(deriveReviewStatus("reviewing")).toBe("in-progress");
    expect(deriveReviewStatus("fixing")).toBe("in-progress");
    expect(deriveReviewStatus("idle")).toBe("pending");
    expect(deriveReviewStatus("active")).toBe("pending");
  });

  it("derives activity", () => {
    expect(deriveActivity("active")).toBe("working");
    expect(deriveActivity("awaiting-plan-approval")).toBe("working");
    expect(deriveActivity("idle")).toBe("idle");
    expect(deriveActivity("ready_for_merge")).toBe("idle");
  });

  it("derives an agent blocker for error/blocked only", () => {
    expect(deriveAgentBlocker("error")).toBe("agent error");
    expect(deriveAgentBlocker("blocked")).toBe("agent blocked");
    expect(deriveAgentBlocker("active")).toBeNull();
  });
});
