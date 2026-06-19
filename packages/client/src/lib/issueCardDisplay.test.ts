import { describe, expect, it } from "vitest";
import { deriveAgingBucket, deriveIssueCardActions, type IssueCardActionInputs } from "./issueCardDisplay.js";

describe("deriveAgingBucket", () => {
  const opts = { showAgingHeatmap: true, agingWarmDays: 3, agingHotDays: 7 };

  it("is always fresh when the heatmap is off", () => {
    expect(deriveAgingBucket(99, { ...opts, showAgingHeatmap: false })).toBe("fresh");
  });

  it("is fresh below the warm threshold", () => {
    expect(deriveAgingBucket(0, opts)).toBe("fresh");
    expect(deriveAgingBucket(2, opts)).toBe("fresh");
  });

  it("is warm between the warm and hot thresholds", () => {
    expect(deriveAgingBucket(3, opts)).toBe("warm");
    expect(deriveAgingBucket(6, opts)).toBe("warm");
  });

  it("is hot at or above the hot threshold", () => {
    expect(deriveAgingBucket(7, opts)).toBe("hot");
    expect(deriveAgingBucket(30, opts)).toBe("hot");
  });
});

describe("deriveIssueCardActions", () => {
  const base: IssueCardActionInputs = {
    statusName: "In Progress",
    isPendingIssue: false,
    hasActiveWorkspace: false,
    hasMainWorkspaceId: false,
    nextStatusName: "In Review",
    canResume: true,
    canOpenDiff: true,
    canStartWorkspace: true,
    canDryRun: true,
    canMoveToNext: true,
  };

  it("hides every action for a pending (optimistic) card", () => {
    const v = deriveIssueCardActions({ ...base, isPendingIssue: true, hasActiveWorkspace: true, hasMainWorkspaceId: true });
    expect(v.showActionRow).toBe(false);
    expect(v.hasAnyAction).toBe(false);
    expect(v.showDiff).toBe(false);
  });

  it("offers start + dry-run when there is no active workspace", () => {
    const v = deriveIssueCardActions({ ...base, hasActiveWorkspace: false });
    expect(v.showStartWorkspace).toBe(true);
    expect(v.showDryRun).toBe(true);
    expect(v.showResume).toBe(false);
    expect(v.showDiff).toBe(false);
  });

  it("offers resume + diff when a workspace is active", () => {
    const v = deriveIssueCardActions({ ...base, hasActiveWorkspace: true, hasMainWorkspaceId: true });
    expect(v.showResume).toBe(true);
    expect(v.showDiff).toBe(true);
    expect(v.showStartWorkspace).toBe(false);
    expect(v.showDryRun).toBe(false);
  });

  it("suppresses the action row for terminal statuses but keeps the diff viewable", () => {
    const v = deriveIssueCardActions({ ...base, statusName: "Done", hasActiveWorkspace: true, hasMainWorkspaceId: true });
    expect(v.showActionRow).toBe(false);
    expect(v.showResume).toBe(false);
    expect(v.showStartWorkspace).toBe(false);
    // Diff keys off !isPendingIssue, not the action-row gate — Done issues still show it.
    expect(v.showDiff).toBe(true);
  });

  it("requires a main workspace id for the diff", () => {
    const v = deriveIssueCardActions({ ...base, hasActiveWorkspace: true, hasMainWorkspaceId: false });
    expect(v.showDiff).toBe(false);
  });

  it("hides move-to-next without a next status", () => {
    expect(deriveIssueCardActions({ ...base, nextStatusName: null }).showMoveToNext).toBe(false);
    expect(deriveIssueCardActions({ ...base, nextStatusName: "Done" }).showMoveToNext).toBe(true);
  });

  it("respects missing callbacks (board didn't wire them)", () => {
    const v = deriveIssueCardActions({
      ...base,
      hasActiveWorkspace: true,
      hasMainWorkspaceId: true,
      canResume: false,
      canOpenDiff: false,
    });
    expect(v.showResume).toBe(false);
    expect(v.showDiff).toBe(false);
  });
});
