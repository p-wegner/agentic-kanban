import { describe, expect, it } from "vitest";
import {
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
