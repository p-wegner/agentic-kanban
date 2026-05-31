import { describe, expect, it } from "vitest";
import {
  emptyWorkflowHistory,
  pushWorkflowHistory,
  redoWorkflowHistory,
  undoWorkflowHistory,
} from "./workflowHistory.js";

describe("workflowHistory", () => {
  it("undoes and redoes snapshots", () => {
    let history = emptyWorkflowHistory<string>();
    history = pushWorkflowHistory(history, "empty");
    history = pushWorkflowHistory(history, "one-node");

    const undone = undoWorkflowHistory(history, "two-nodes");
    expect(undone.snapshot).toBe("one-node");
    expect(undone.history.future).toEqual(["two-nodes"]);

    const redone = redoWorkflowHistory(undone.history, "one-node");
    expect(redone.snapshot).toBe("two-nodes");
    expect(redone.history.past).toEqual(["empty", "one-node"]);
  });

  it("clears redo history when a new snapshot is pushed", () => {
    let history = emptyWorkflowHistory<string>();
    history = pushWorkflowHistory(history, "empty");
    const undone = undoWorkflowHistory(history, "one-node");

    const next = pushWorkflowHistory(undone.history, "changed-after-undo");
    expect(next.future).toEqual([]);
    expect(next.past).toEqual(["changed-after-undo"]);
  });

  it("bounds history to the configured limit", () => {
    let history = emptyWorkflowHistory<number>();
    for (let i = 0; i < 55; i += 1) {
      history = pushWorkflowHistory(history, i, 50);
    }

    expect(history.past).toHaveLength(50);
    expect(history.past[0]).toBe(5);
    expect(history.past.at(-1)).toBe(54);
  });
});
