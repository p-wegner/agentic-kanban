import { describe, expect, it } from "vitest";
import {
  computeBlockerReadiness,
  isTerminalStatusView,
  isTerminalStatusIdView,
  isResolvedDependencyStatusView,
  LEGACY_TERMINAL_STATUS_NAMES,
} from "@agentic-kanban/shared";

// Regression coverage for #537: a workflow-driven issue (currentNodeId != null) whose
// currentNode was never advanced to an `end` node, but whose STATUS is terminal (Done),
// must still read as terminal/resolved — otherwise blocked_by/depends_on dependents never
// unblock under the monitor/board/dependency-wave planner.
describe("status-view terminal/resolved checks (#537)", () => {
  const DONE_ID = "done-status-id";
  const doneIds = new Set([DONE_ID]);

  it("treats a Done-STATUS issue as terminal even when workflow-driven with a non-end node", () => {
    const stuck = { currentNodeId: "node-review", currentNodeType: "normal", statusName: "Done", statusId: DONE_ID };
    expect(isTerminalStatusView(stuck, LEGACY_TERMINAL_STATUS_NAMES)).toBe(true);
    expect(isTerminalStatusIdView(stuck, doneIds)).toBe(true);
    expect(isResolvedDependencyStatusView(stuck)).toBe(true);
  });

  it("still resolves via the end node when status is non-terminal but node is end", () => {
    const ended = { currentNodeId: "node-done", currentNodeType: "end", statusName: "In Review", statusId: "ir-id" };
    expect(isTerminalStatusView(ended)).toBe(true);
    expect(isTerminalStatusIdView(ended, doneIds)).toBe(true);
  });

  it("does NOT treat an active workflow issue as terminal (non-end node, non-terminal status)", () => {
    const active = { currentNodeId: "node-impl", currentNodeType: "start", statusName: "In Progress", statusId: "ip-id" };
    expect(isTerminalStatusView(active)).toBe(false);
    expect(isTerminalStatusIdView(active, doneIds)).toBe(false);
    expect(isResolvedDependencyStatusView(active)).toBe(false);
  });

  it("handles non-workflow issues purely by status (unchanged)", () => {
    const doneNoNode = { currentNodeId: null, currentNodeType: null, statusName: "Done", statusId: DONE_ID };
    const todoNoNode = { currentNodeId: null, currentNodeType: null, statusName: "Todo", statusId: "todo-id" };
    expect(isTerminalStatusView(doneNoNode)).toBe(true);
    expect(isTerminalStatusIdView(doneNoNode, doneIds)).toBe(true);
    expect(isTerminalStatusView(todoNoNode)).toBe(false);
    expect(isTerminalStatusIdView(todoNoNode, doneIds)).toBe(false);
  });

  it("resolves AI Reviewed as a dependency (but not as a hard-terminal status)", () => {
    const aiReviewed = { currentNodeId: null, currentNodeType: null, statusName: "AI Reviewed", statusId: "air-id" };
    expect(isResolvedDependencyStatusView(aiReviewed)).toBe(true);
    expect(isTerminalStatusView(aiReviewed)).toBe(false);
  });
});

// The ONE shared dependency-readiness predicate used by both runAutoStart and the
// dependency-wave planner (#798). Covers the #782 fan-in and #784 closed-but-unmerged cases.
describe("computeBlockerReadiness (#798)", () => {
  it("is not ready when the blocker is non-terminal, regardless of workspaces", () => {
    expect(computeBlockerReadiness({ isTerminal: false, workspaces: [] })).toBe(false);
    expect(computeBlockerReadiness({ isTerminal: false, workspaces: [{ mergedAt: "2026-01-01", isDirect: false }] })).toBe(false);
  });

  it("treats a terminal blocker with no workspace as landed (resolved manually)", () => {
    expect(computeBlockerReadiness({ isTerminal: true, workspaces: [] })).toBe(true);
  });

  it("is ready when a terminal blocker has a merged workspace", () => {
    expect(computeBlockerReadiness({ isTerminal: true, workspaces: [{ mergedAt: "2026-01-01T00:00:00Z", isDirect: false }] })).toBe(true);
  });

  it("is ready when a terminal blocker committed directly (isDirect, no merge step)", () => {
    expect(computeBlockerReadiness({ isTerminal: true, workspaces: [{ mergedAt: null, isDirect: true }] })).toBe(true);
  });

  // #784: a blocker can be at a terminal/closed STATUS while its branch→base merge is
  // still queued for the async orchestrator — mergedAt unset, not direct. NOT landed.
  it("is NOT ready when a terminal blocker's only workspace is closed-but-unmerged (#784)", () => {
    expect(computeBlockerReadiness({ isTerminal: true, workspaces: [{ mergedAt: null, isDirect: false }] })).toBe(false);
  });

  // #782: a fan-in dependent has multiple blockers; it must stay blocked until ALL of
  // them land. computeBlockerReadiness is per-blocker — callers AND it across blockers,
  // so any single un-landed blocker keeps the dependent blocked.
  it("keeps a fan-in dependent blocked until every blocker lands (#782)", () => {
    const landed = { isTerminal: true, workspaces: [{ mergedAt: "2026-01-01T00:00:00Z", isDirect: false }] };
    const unmerged = { isTerminal: true, workspaces: [{ mergedAt: null, isDirect: false }] };
    // One landed + one still-unmerged ⇒ the dependent's AND-over-blockers is false.
    expect([landed, unmerged].every(computeBlockerReadiness)).toBe(false);
    // Once the second blocker lands too, the fan-in dependent is ready.
    expect([landed, landed].every(computeBlockerReadiness)).toBe(true);
  });
});
