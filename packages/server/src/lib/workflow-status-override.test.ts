import { describe, it, expect } from "vitest";
import { workflowNodeMayOverrideStatus } from "./workflow-status-override.js";

const ORDER = ["Backlog", "Todo", "In Progress", "In Review", "AI Reviewed", "Done", "Cancelled"];

describe("workflowNodeMayOverrideStatus", () => {
  it("lets a node AHEAD of the issue override (workflow advanced, issue row lagging)", () => {
    expect(workflowNodeMayOverrideStatus("In Progress", "In Review", ORDER)).toBe(true);
    expect(workflowNodeMayOverrideStatus("Backlog", "In Progress", ORDER)).toBe(true);
  });

  it("never lets a node BEHIND the issue drag it back (manual move to an unmapped status)", () => {
    expect(workflowNodeMayOverrideStatus("In Review", "In Progress", ORDER)).toBe(false);
    expect(workflowNodeMayOverrideStatus("AI Reviewed", "In Review", ORDER)).toBe(false);
  });

  it("is a no-op when node and issue agree", () => {
    expect(workflowNodeMayOverrideStatus("In Review", "In Review", ORDER)).toBe(false);
    expect(workflowNodeMayOverrideStatus("in review", "In Review", ORDER)).toBe(false);
  });

  it("never overrides with a node status the project does not have", () => {
    expect(workflowNodeMayOverrideStatus("In Progress", "Deploying", ORDER)).toBe(false);
  });

  it("keeps the legacy node-wins behaviour when the issue status is unknown", () => {
    expect(workflowNodeMayOverrideStatus(null, "In Progress", ORDER)).toBe(true);
    expect(workflowNodeMayOverrideStatus("Custom", "In Progress", ORDER)).toBe(true);
  });
});
