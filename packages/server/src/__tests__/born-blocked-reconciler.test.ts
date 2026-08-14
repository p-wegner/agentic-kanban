// @covers workspaces.bornBlocked [recovery, boundary]
//
// #394 — a workspace inserted and set `blocked` in the same millisecond, with ZERO session rows.
// Found on eventhub while verifying #387: that fix released all 12 quota-blocked workspaces, and
// six stayed blocked for this unrelated reason (issues #84, #85, #92 ×2, #93 ×2), one of them
// under an already-Done ticket.
//
// It was permanent by construction: `handleBlockedWorkspace` releases only a quota block (no
// session ⇒ no stats blob to classify), `reconcileCompletionStates` innerJoins `sessions` so it
// excludes these under every configuration, and nothing else transitions `blocked`.
//
// The policy under test is mostly about what NOT to do — specifically, not releasing a
// setup-failed workspace straight to `idle`, which would hand the start path a worktree with
// known-missing dependencies and reintroduce the opaque merge-gate failure #169 exists to prevent.
import { describe, expect, it } from "vitest";
import { decideBornBlockedAction, SETUP_RETRY_INTERVAL_MS, type BornBlockedRow } from "../startup/born-blocked-reconciler.js";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");

function row(overrides: Partial<BornBlockedRow> = {}): BornBlockedRow {
  return {
    workspaceId: "ws-1",
    issueId: "issue-1",
    issueNumber: 92,
    issueStatusName: "In Review",
    projectId: "proj-1",
    workingDir: "/repo/.worktrees/ak-92",
    setupScript: "pnpm install -r",
    setupState: "failed",
    setupEndedAt: new Date(NOW - 5 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("decideBornBlockedAction (#394)", () => {
  it("retries the setup script that failed, rather than releasing into a broken worktree", () => {
    const decision = decideBornBlockedAction(row(), NOW);
    expect(decision.action).toBe("retry-setup");
  });

  it("holds while the last attempt is still recent, so a sweep cannot hammer a slow install", () => {
    const recent = row({ setupEndedAt: new Date(NOW - SETUP_RETRY_INTERVAL_MS / 2).toISOString() });
    expect(decideBornBlockedAction(recent, NOW).action).toBe("hold");
  });

  it("closes the workspace when its issue is already Done — eventhub's #85", () => {
    // `ACTIVE_WORKSPACE_STATUSES` includes `blocked`, so this row kept counting toward
    // `activeIssueCount` and re-supplying a stall signal for finished work.
    expect(decideBornBlockedAction(row({ issueStatusName: "Done" }), NOW).action).toBe("close");
  });

  it("closes it under a Cancelled issue too", () => {
    expect(decideBornBlockedAction(row({ issueStatusName: "Cancelled" }), NOW).action).toBe("close");
  });

  it("closing wins over a pending setup retry — a terminal issue needs no worktree", () => {
    const doneWithFailedSetup = row({ issueStatusName: "Done", setupState: "failed" });
    expect(decideBornBlockedAction(doneWithFailedSetup, NOW).action).toBe("close");
  });

  it("releases a workspace blocked with NO recorded reason — a status with no evidence attached", () => {
    // Nothing known-broken to protect against, so the ordinary rules get it back.
    expect(decideBornBlockedAction(row({ setupState: null }), NOW).action).toBe("release");
    expect(decideBornBlockedAction(row({ setupState: "succeeded" }), NOW).action).toBe("release");
  });

  it("holds a setup failure with no script or worktree left to retry", () => {
    expect(decideBornBlockedAction(row({ setupScript: null }), NOW).action).toBe("hold");
    expect(decideBornBlockedAction(row({ workingDir: null }), NOW).action).toBe("hold");
  });

  it("retries when the failure has no readable timestamp rather than holding forever", () => {
    // An unparseable date must not become a permanent hold — that is the bug being fixed.
    expect(decideBornBlockedAction(row({ setupEndedAt: null }), NOW).action).toBe("retry-setup");
    expect(decideBornBlockedAction(row({ setupEndedAt: "not-a-date" }), NOW).action).toBe("retry-setup");
  });

  it("names its reason, so the sweep log explains every decision", () => {
    expect(decideBornBlockedAction(row({ issueStatusName: "Done" }), NOW).reason).toContain("Done");
  });
});
