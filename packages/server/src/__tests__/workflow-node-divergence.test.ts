// @covers workflow.nodeStatusDivergence [correctness, boundary]
//
// #395 / #397 — the two directions of node↔status divergence #381 did not cover.
//
// #395 (MEASURED, eventhub): eight issues with `current_node_id` on a `node_type = 'end'` node
// while `status_id` still resolved to In Review. The monitor's candidate query excluded an
// end-node issue outright, so those issues left automation entirely — including two holding
// `ready_for_merge` workspaces that had not merged in ~1000 minutes with auto-merge on.
//
// #397 (roomsync round 14): a completed, merged, human-approved pipeline ticket sat In Progress on
// the workflow's START node, `status_changed_at` seven minutes AFTER its workspace closed. Nothing
// recovers it — the workspace is closed, so there is no monitor candidate, and no reconciler moves
// an issue off a start node.
import { describe, expect, it } from "vitest";
import { decideNodeDivergence, type NodeDivergenceRow } from "../startup/workflow-node-divergence-reconciler.js";

function row(overrides: Partial<NodeDivergenceRow> = {}): NodeDivergenceRow {
  return {
    issueId: "issue-1",
    issueNumber: 97,
    projectId: "proj-1",
    issueStatusName: "In Review",
    nodeType: "end",
    nodeStatusName: "Done",
    hasLiveWorkspace: true,
    hasMergedWorkspace: false,
    ...overrides,
  };
}

describe("decideNodeDivergence — the end-node forward divergence (#395)", () => {
  it("clears the node when an END node hides a live workspace", () => {
    // The status wins because there is committed work that never landed; clearing also puts the
    // issue back in the monitor walk, which is the half that actually costs work.
    const decision = decideNodeDivergence(row());
    expect(decision.action).toBe("clear-node");
    expect(decision.reason).toContain("END node");
  });

  it("leaves an end-node issue alone once its status is Done — that is the normal finished state", () => {
    expect(decideNodeDivergence(row({ issueStatusName: "Done", hasLiveWorkspace: false })).action).toBe("none");
  });

  it("leaves a Cancelled issue alone", () => {
    expect(decideNodeDivergence(row({ issueStatusName: "Cancelled" })).action).toBe("none");
  });

  it("does not touch an issue mid-workflow on a non-end node", () => {
    expect(decideNodeDivergence(row({ nodeType: "task", nodeStatusName: "In Progress" })).action).toBe("none");
  });

  it("does not clear an end node when nothing is live and nothing merged — there is no work to protect", () => {
    // A stale end node with no workspace at all is a rendering question, not a stranding; #381
    // owns that direction and clearing here would fight it.
    expect(decideNodeDivergence(row({ hasLiveWorkspace: false })).action).toBe("none");
  });
});

describe("decideNodeDivergence — the backwards node regression (#397)", () => {
  it("converges a merged issue with no live workspace to Done, whatever node it regressed to", () => {
    const regressed = row({
      issueStatusName: "In Progress", nodeType: "start", nodeStatusName: "In Progress",
      hasLiveWorkspace: false, hasMergedWorkspace: true,
    });
    const decision = decideNodeDivergence(regressed);
    expect(decision.action).toBe("converge-done");
    expect(decision.reason).toContain("START node");
  });

  it("does NOT converge while a workspace is still live — the merge may be one of several repos", () => {
    // The merge landing is not by itself proof the ticket is finished; a live workspace means
    // something is still in flight, and forcing Done there would close work in progress.
    const stillWorking = row({ hasLiveWorkspace: true, hasMergedWorkspace: true });
    expect(decideNodeDivergence(stillWorking).action).not.toBe("converge-done");
  });

  it("prefers converge-done over clear-node when both could apply", () => {
    // A merged end-node issue with nothing live is finished; clearing its node would leave it
    // open and misfiled instead.
    const merged = row({ nodeType: "end", hasLiveWorkspace: false, hasMergedWorkspace: true });
    expect(decideNodeDivergence(merged).action).toBe("converge-done");
  });

  it("does nothing for an ordinary in-flight ticket", () => {
    const normal = row({
      issueStatusName: "In Progress", nodeType: "task", nodeStatusName: "In Progress",
      hasLiveWorkspace: true, hasMergedWorkspace: false,
    });
    expect(decideNodeDivergence(normal).action).toBe("none");
  });
});
