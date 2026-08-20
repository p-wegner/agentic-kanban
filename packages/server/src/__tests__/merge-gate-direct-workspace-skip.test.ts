// @covers review-merge.gate.pre-lock [cost,workflow]
/**
 * A direct workspace's merge must not pay for the verify gate (#276).
 *
 * A direct workspace has no worktree and no branch of its own — its branch IS the default
 * branch — so `doMerge` resolves it to a plain close (`handleWorkspaceMergeResolution` →
 * "direct-closed") and lands nothing. That short-circuit lives inside the merge EXECUTOR,
 * i.e. after `runPreLockGate`, so closing one used to run the full verify_script first.
 * Observed closing #232: a ~50-minute build+test run that then died with `verify_script
 * timed out after 3000000ms`, to close a workspace that was never going to merge anything.
 * The only clean close available that day was a raw `PATCH status=closed`.
 *
 * There is no diff to verify, so the gate has nothing to decide. These tests pin that the
 * skip is keyed on `isDirect` alone and does not leak into ordinary workspaces.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Database } from "../db/index.js";
import type { workspaces } from "@agentic-kanban/shared/schema";

const resolveMergeGateMock = vi.fn(async () => ({
  passed: true,
  ran: true,
  stage: "verify" as const,
  message: "ok",
  decision: "run-gate" as const,
}));

vi.mock("../services/pre-merge-gate.service.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveMergeGateShas: vi.fn(async () => ({ branchSha: "a", baseSha: "b" })),
    resolveMergeGate: (...args: unknown[]) => resolveMergeGateMock(...(args as [])),
  };
});

const { runPreLockGate } = await import("../services/workspace-merge-gate.js");

const RUN_GATE_TOKEN = { kind: "run-gate" as const };

function makeWorkspace(isDirect: boolean) {
  return {
    id: "ws-1",
    issueId: "issue-1",
    isDirect,
    // A direct workspace's workingDir is the project repo itself, not a worktree.
    workingDir: isDirect ? "/repo" : "/repo/.worktrees/ws-1",
  } as unknown as typeof workspaces.$inferSelect;
}

function callRunPreLockGate(isDirect: boolean) {
  return runPreLockGate({
    workspaceId: "ws-1",
    workspace: makeWorkspace(isDirect),
    projectId: "project-1",
    baseBranch: "master",
    token: RUN_GATE_TOKEN,
    database: {} as Database,
    recordMergeAttempt: async () => {},
  });
}

describe("pre-lock gate skips direct workspaces (#276)", () => {
  beforeEach(() => {
    resolveMergeGateMock.mockClear();
  });

  it("does not run the gate at all for a direct workspace", async () => {
    await callRunPreLockGate(true);

    expect(resolveMergeGateMock).not.toHaveBeenCalled();
  });

  it("returns the caller's token unchanged, so the executor reaches its direct-closed preflight", async () => {
    // Returning RUN_GATE rather than minted evidence is deliberate: `doMerge` resolves the
    // direct workspace to a completed close BEFORE it consults the token, so there is
    // nothing to prove — and fabricating an `already-passed` proof for a run that never
    // happened is exactly what #243 exists to prevent.
    expect(await callRunPreLockGate(true)).toBe(RUN_GATE_TOKEN);
  });

  it("still gates an ordinary workspace — the skip is keyed on isDirect only", async () => {
    const token = await callRunPreLockGate(false);

    expect(resolveMergeGateMock).toHaveBeenCalledTimes(1);
    expect(token.kind).toBe("already-passed");
  });
});
