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
  };
});

const { runPreLockGate } = await import("../services/workspace-merge-gate.js");
const { getBaseBranchHealthAtMergeBase } = await import("../services/base-branch-health.service.js");

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
