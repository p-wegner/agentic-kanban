/**
 * #363 / #336 — `awaitingMerge` was blind to a whole class of stall, and the fix must not make it
 * lie about the class it can now see.
 *
 * The live stall (kassenbuch issue #7, `feature/ak-7-pm-pipeline-7-9-test-qa-plan`): workspace
 * `status: ready_for_merge` since 20:18:13Z, issue `In Progress` and never advanced, held 12+
 * minutes. `listPluginLoopUnmergedWorkspaces` required the ISSUE status to be In Review / AI
 * Reviewed / Done, so the row was filtered out and `awaitingMerge` stayed `null` — the one
 * indicator built to catch a silent loop stall could not represent this stall at all.
 *
 * The trap, and the reason half these tests are about what the fix must NOT do: in that worktree
 * `git log master..HEAD` was EMPTY. The branch had no commits. Simply widening the query and
 * rendering the existing "Step done — waiting for merge / Merge now" card would have replaced a
 * silent stall with a confident wrong answer, and the merge would have closed the unit without its
 * artifacts — the deadlock `exit-workflow.ts` already refuses by name.
 */
import { describe, expect, it } from "vitest";
import type { PluginLoopGate, PluginLoopProgressStep } from "@agentic-kanban/shared/lib/plugin-manifest";
import type { LoopUnmergedWorkspaceRow } from "../repositories/plugins.repository.js";
import { classifyLoopStall, selectLoopStall } from "../services/plugin-loop-stall.js";

function row(overrides: Partial<LoopUnmergedWorkspaceRow> = {}): LoopUnmergedWorkspaceRow {
  return {
    workspaceId: "ws-1",
    issueId: "issue-1",
    issueNumber: 7,
    issueTitle: "PM pipeline 7/9: Test & QA Plan",
    issueStatusName: "In Progress",
    externalKey: "plugin-loop:pm-pipeline:pipeline:step-7:v1",
    workspaceStatus: "ready_for_merge",
    workspaceReadyForMerge: false,
    workspaceUpdatedAt: "2026-08-08T20:18:13.402Z",
    issueHasMergedWorkspace: false,
    ...overrides,
  };
}

const gate = (id: string): PluginLoopGate => ({
  id, question: "Approve?", actions: [{ id: "approve", label: "Approve" }],
} as PluginLoopGate);

const steps = (...entries: Array<[string, PluginLoopProgressStep["state"]]>): { steps: PluginLoopProgressStep[] } => ({
  steps: entries.map(([id, state]) => ({ id, label: id, state })),
});

describe("classifyLoopStall (#363)", () => {
  it("classifies the measured #363 state as parked-with-unfinished-ticket and refuses a merge", () => {
    const stall = classifyLoopStall(row());
    expect(stall.reason).toBe("workspace-parked-issue-unfinished");
    // The whole point: the branch may be empty, so no one-click merge.
    expect(stall.mergeSafe).toBe(false);
    expect(stall.detail).toContain("ready_for_merge");
    expect(stall.detail).toContain("In Progress");
    expect(stall.since).toBe("2026-08-08T20:18:13.402Z");
  });

  it("still classifies #299's state as finished-unmerged, where merging IS the right action", () => {
    const stall = classifyLoopStall(row({ issueStatusName: "In Review", workspaceStatus: "idle" }));
    expect(stall.reason).toBe("builder-finished-unmerged");
    expect(stall.mergeSafe).toBe(true);
  });

  it.each(["In Review", "AI Reviewed", "Done"])(
    "prefers the issue-status reading when BOTH hold (issue %s + workspace ready_for_merge)",
    (issueStatusName) => {
      // An In-Review ticket whose workspace also reached ready_for_merge is #299's ordinary state
      // and its branch is the one carrying the work — degrading it to "inspect" would regress #299.
      const stall = classifyLoopStall(row({ issueStatusName, workspaceStatus: "ready_for_merge" }));
      expect(stall.reason).toBe("builder-finished-unmerged");
      expect(stall.mergeSafe).toBe(true);
    },
  );

  it("reports the status/readyForMerge contradiction instead of picking a winner", () => {
    // Measured on the live row: `status: "ready_for_merge"` with `readyForMerge: false`. Whichever
    // column a consumer reads, it gets the opposite answer.
    expect(classifyLoopStall(row({ workspaceReadyForMerge: false })).contradictoryReadyFlag).toBe(true);
    expect(classifyLoopStall(row({ workspaceReadyForMerge: true })).contradictoryReadyFlag).toBe(false);
    // Not a contradiction when the workspace is not claiming ready_for_merge at all.
    expect(classifyLoopStall(row({ workspaceStatus: "idle", workspaceReadyForMerge: false })).contradictoryReadyFlag).toBe(false);
  });

  it("falls back to the issue id when the ticket has no number", () => {
    expect(classifyLoopStall(row({ issueNumber: null })).detail).toContain("issue-1");
  });
});

describe("selectLoopStall (#363) — pre-existing behaviour preserved", () => {
  it("retires a row whose unit the planner has already accounted for (#326/#353)", () => {
    // A gate for the same unit means the planner has SEEN the artifacts in the main checkout.
    expect(selectLoopStall([row()], gate("step-7:v1"), null)).toBeNull();
    expect(selectLoopStall([row()], null, steps(["step-7", "done"]))).toBeNull();
  });

  it("keeps a row it cannot attribute to a unit — hiding it is the #336 failure mode", () => {
    const stall = selectLoopStall([row({ externalKey: null })], gate("step-7:v1"), null);
    expect(stall).not.toBeNull();
  });

  it("surfaces the OLDEST issue number — on a sequential pipeline that is the blocker", () => {
    const stall = selectLoopStall(
      [
        row({ workspaceId: "ws-9", issueNumber: 9, externalKey: "plugin-loop:pm-pipeline:pipeline:step-9:v1" }),
        row({ workspaceId: "ws-7", issueNumber: 7 }),
      ],
      null,
      null,
    );
    expect(stall?.workspaceId).toBe("ws-7");
  });

  it("returns null when there is nothing stuck", () => {
    expect(selectLoopStall([], null, null)).toBeNull();
  });
});

describe("#337: an ALREADY-LANDED unit must never be offered a merge", () => {
  /**
   * MEASURED on kassenbuch round 3, in the ~5-minute window between "step agent finished" and
   * "after-merge review workspace closed": `awaitingMerge` pointed at that review workspace while
   * the ticket was already Done and the merge commit was already on master, and the loop card
   * rendered a literal "Merge now" button. That is the worst possible affordance there, because the
   * operator documentation maps this exact state to "click Merge now on the loop card". The operator
   * checked `git log` first and did nothing — the guard is what makes that care unnecessary.
   *
   * The evidence is DB-only by design: a SIBLING workspace on the same issue with `mergedAt` set.
   * `loopStatuses` runs on every plugin-surface read, so a git reachability check here would feed
   * exactly the cost #359 is about.
   */
  const landedLeftover = () => row({
    workspaceId: "ws-review",
    issueStatusName: "Done",
    workspaceStatus: "reviewing",
    issueHasMergedWorkspace: true,
  });

  it("classifies it as unit-already-landed and refuses the merge affordance", () => {
    const stall = classifyLoopStall(landedLeftover());
    expect(stall.reason).toBe("unit-already-landed");
    expect(stall.mergeSafe).toBe(false);
    expect(stall.detail).toContain("MERGED workspace");
  });

  it("overrides the finished-by-issue branch, which is where the wrong answer came from", () => {
    // A Done issue with an open unmerged workspace took `builder-finished-unmerged` with
    // mergeSafe: true. That verdict is right when nothing landed and wrong when something did, and
    // the row alone could not tell those apart before `issueHasMergedWorkspace`.
    expect(classifyLoopStall(row({ issueStatusName: "Done", issueHasMergedWorkspace: false })).mergeSafe).toBe(true);
    expect(classifyLoopStall(row({ issueStatusName: "Done", issueHasMergedWorkspace: true })).mergeSafe).toBe(false);
  });

  it("does not let a landed leftover mask a LATER unit that genuinely never landed", () => {
    // Selection ordered purely by issue number, so an earlier unit's leftover would win the single
    // stall slot and hide the real one — trading a misleading card for a missing one.
    const stall = selectLoopStall([
      landedLeftover(),
      row({ workspaceId: "ws-real", issueNumber: 9, issueStatusName: "In Review", workspaceStatus: "idle" }),
    ], null, null);
    expect(stall?.workspaceId).toBe("ws-real");
    expect(stall?.mergeSafe).toBe(true);
  });

  it("still reports the leftover when it is the only row — 'nothing to do here' is a real answer", () => {
    const stall = selectLoopStall([landedLeftover()], null, null);
    expect(stall?.reason).toBe("unit-already-landed");
  });
});
