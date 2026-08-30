/**
 * #491 — a branch gate failure states the base's status at its merge-base. Test: a red base
 * plus a green branch produces a gate message that attributes the failure to the base, not the
 * branch under test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Database } from "../db/index.js";
import type { workspaces } from "@agentic-kanban/shared/schema";

vi.mock("../services/pre-merge-gate.service.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveMergeGateShas: vi.fn(async () => ({ branchSha: "branch-tip", baseSha: "base-tip" })),
    // The gate FAILS — this is what a red gate on a clean branch looks like when the base is
    // actually the one that's broken (the ticket's core scenario: a green branch, a red base).
    resolveMergeGate: vi.fn(async () => ({
      passed: false,
      ran: true,
      stage: "verify" as const,
      message: "verify_script failed (exit 1): TypeError: cannot read property of undefined",
      decision: "run-gate" as const,
    })),
  };
});

vi.mock("../services/base-branch-health.service.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getBaseBranchHealthAtMergeBase: vi.fn(),
    // #935: the gate asks for a fresh probe when the recorded health is a non-answer. Stubbed
    // here so the test never spawns a real clone/install/verify — which is precisely the
    // machine saturation this ticket is about.
    verifyBaseBranchHealth: vi.fn(async () => null),
  };
});

// #935: the gate asks for a fresh probe THROUGH the due-check, never through the probe
// directly — the due-check is what applies the #931 gate-busy yield and the #712 timeout
// back-off. Mocked here so the test asserts the routing without spawning anything.
vi.mock("../services/base-branch-health-reprobe.service.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    requestBaseBranchReprobe: vi.fn(async () => ({ due: true, reason: "interval_elapsed" as const })),
  };
});

const { runPreLockGate } = await import("../services/workspace-merge-gate.js");
const { getBaseBranchHealthAtMergeBase, verifyBaseBranchHealth } = await import("../services/base-branch-health.service.js");
const { requestBaseBranchReprobe } = await import("../services/base-branch-health-reprobe.service.js");

const RUN_GATE_TOKEN = { kind: "run-gate" as const };
const workspace = {
  id: "ws-1",
  workingDir: "/repo/.worktrees/ws-1",
  issueId: "issue-1",
  isDirect: false,
} as unknown as typeof workspaces.$inferSelect;

type RecordMergeAttempt = Parameters<typeof runPreLockGate>[0]["recordMergeAttempt"];

async function callRunPreLockGate(recordMergeAttempt: RecordMergeAttempt) {
  return runPreLockGate({
    workspaceId: "ws-1",
    workspace,
    projectId: "project-1",
    baseBranch: "master",
    token: RUN_GATE_TOKEN,
    database: {} as Database,
    recordMergeAttempt,
  });
}

describe("runPreLockGate attributes a gate failure to an already-red base (#491)", () => {
  beforeEach(() => {
    vi.mocked(getBaseBranchHealthAtMergeBase).mockReset();
    vi.mocked(verifyBaseBranchHealth).mockReset();
    vi.mocked(verifyBaseBranchHealth).mockResolvedValue(null);
    vi.mocked(requestBaseBranchReprobe).mockReset();
    vi.mocked(requestBaseBranchReprobe).mockResolvedValue({ due: true, reason: "interval_elapsed" });
  });

  it("prefixes the withhold message with the base's red status when the base was already broken", async () => {
    vi.mocked(getBaseBranchHealthAtMergeBase).mockResolvedValue({
      mergeBaseSha: "base-tip",
      health: {
        id: "row-1",
        projectId: "project-1",
        sha: "base-tip",
        branch: "master",
        outcome: "red",
        durationMs: 1000,
        message: "master's own verify_script fails independent of any branch",
        failedSuites: null,
        createdAt: new Date().toISOString(),
      },
    });

    const recorded: string[] = [];
    const recordMergeAttempt = vi.fn(async (_ws: unknown, _eventType: string, body: string) => {
      recorded.push(body);
    });

    await expect(callRunPreLockGate(recordMergeAttempt)).rejects.toThrow(/Pre-merge gate failed/);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toContain("BASE BRANCH ALREADY RED");
    expect(recorded[0]).toContain("master's own verify_script fails independent of any branch");
    // The branch's own (real) gate failure message must still be present, not replaced.
    expect(recorded[0]).toContain("TypeError: cannot read property of undefined");
  });

  it("does NOT attribute to the base when the base was green — the branch is genuinely at fault", async () => {
    vi.mocked(getBaseBranchHealthAtMergeBase).mockResolvedValue({
      mergeBaseSha: "base-tip",
      health: {
        id: "row-1",
        projectId: "project-1",
        sha: "base-tip",
        branch: "master",
        outcome: "green",
        durationMs: 1000,
        message: null,
        failedSuites: null,
        createdAt: new Date().toISOString(),
      },
    });

    const recorded: string[] = [];
    const recordMergeAttempt = vi.fn(async (_ws: unknown, _eventType: string, body: string) => {
      recorded.push(body);
    });

    await expect(callRunPreLockGate(recordMergeAttempt)).rejects.toThrow(/Pre-merge gate failed/);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).not.toContain("BASE BRANCH ALREADY RED");
    expect(recorded[0]).toContain("TypeError: cannot read property of undefined");
  });

  it("does NOT attribute when nothing was ever recorded for the base — silent, no false attribution", async () => {
    vi.mocked(getBaseBranchHealthAtMergeBase).mockResolvedValue({ mergeBaseSha: "base-tip", health: null });

    const recorded: string[] = [];
    const recordMergeAttempt = vi.fn(async (_ws: unknown, _eventType: string, body: string) => {
      recorded.push(body);
    });

    await expect(callRunPreLockGate(recordMergeAttempt)).rejects.toThrow(/Pre-merge gate failed/);
    expect(recorded[0]).not.toContain("BASE BRANCH ALREADY");
  });

  it("does NOT attribute to the base when the probe TIMED OUT — a starved probe is not a red base (#935)", async () => {
    // The ticket's core scenario: master is green (a full test:mine passed, exit 0) but the
    // cached verdict says TIMEOUT because the probe ran on a saturated box. The branch's own
    // failure must stand exactly as it would against a green base.
    vi.mocked(getBaseBranchHealthAtMergeBase).mockResolvedValue({
      mergeBaseSha: "base-tip",
      health: {
        id: "row-1",
        projectId: "project-1",
        sha: "base-tip",
        branch: "master",
        outcome: "timeout",
        durationMs: 2_700_123,
        message: "verify_script timed out after 2700000ms (probe ran 2700123ms with KANBAN_TEST_MAX_WORKERS=4)",
        failedSuites: null,
        createdAt: new Date().toISOString(),
      },
      recordedSha: "base-tip",
      ageMs: 3 * 60 * 60 * 1000,
    });

    const recorded: string[] = [];
    const recordMergeAttempt = vi.fn(async (_ws: unknown, _eventType: string, body: string) => {
      recorded.push(body);
    });

    await expect(callRunPreLockGate(recordMergeAttempt)).rejects.toThrow(/Pre-merge gate failed/);

    expect(recorded).toHaveLength(1);
    // The exact stamp the board was producing for hours against a green master.
    expect(recorded[0]).not.toContain("BASE BRANCH ALREADY TIMEOUT");
    expect(recorded[0]).not.toContain("BASE BRANCH ALREADY");
    // ...and the branch is not excused: its own failure is still what the message reports.
    expect(recorded[0]).not.toContain("may not be caused by this branch");
    expect(recorded[0]).toContain("TypeError: cannot read property of undefined");
    // A stale non-answer is sticky (the sweep backs a timeout off by a full probe duration on
    // top of its interval), so the gate asks for a fresh measurement instead of waiting it out.
    // Through the DUE-CHECK, never the probe directly: the due-check is what still applies the
    // #931 gate-busy yield and the #712 back-off, so a project stuck on a non-answer row cannot
    // re-spawn a 45-minute verify on every failing gate.
    await vi.waitFor(() => expect(requestBaseBranchReprobe).toHaveBeenCalledWith("project-1", expect.anything()));
    expect(verifyBaseBranchHealth).not.toHaveBeenCalled();
  });

  it("does NOT request a re-probe when the base health is a real verdict (#935)", async () => {
    // A green or red row was measured; re-probing it would just burn the box's cores for an
    // answer we already have. Only a non-answer earns a fresh run.
    vi.mocked(getBaseBranchHealthAtMergeBase).mockResolvedValue({
      mergeBaseSha: "base-tip",
      health: {
        id: "row-1",
        projectId: "project-1",
        sha: "base-tip",
        branch: "master",
        outcome: "red",
        durationMs: 1000,
        message: "master is genuinely broken",
        failedSuites: null,
        createdAt: new Date().toISOString(),
      },
    });

    await expect(callRunPreLockGate(vi.fn(async () => {}))).rejects.toThrow(/Pre-merge gate failed/);
    expect(requestBaseBranchReprobe).not.toHaveBeenCalled();
    expect(verifyBaseBranchHealth).not.toHaveBeenCalled();
  });

  it("still reports the (unattributed) gate failure when the base-health lookup itself errors", async () => {
    vi.mocked(getBaseBranchHealthAtMergeBase).mockRejectedValue(new Error("git spawn failed"));

    const recorded: string[] = [];
    const recordMergeAttempt = vi.fn(async (_ws: unknown, _eventType: string, body: string) => {
      recorded.push(body);
    });

    await expect(callRunPreLockGate(recordMergeAttempt)).rejects.toThrow(/Pre-merge gate failed/);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toContain("TypeError: cannot read property of undefined");
  });
});
