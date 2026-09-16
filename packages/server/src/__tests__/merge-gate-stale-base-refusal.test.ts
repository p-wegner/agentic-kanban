/**
 * #1169 — a branch left In Review while its base advances is never rebased by any board path,
 * so its diff against the current base becomes a large REVERSION of everything the base landed
 * meanwhile. The gate then fails on that reversion and blames whichever base file it touches —
 * a file the ticket never edited. Test: a badly-stale branch is refused BEFORE the gate runs,
 * with a message naming the staleness, and a branch within the threshold is unaffected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Database } from "../db/index.js";
import type { workspaces } from "@agentic-kanban/shared/schema";

vi.mock("../services/git.service.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    countBehindCommits: vi.fn(),
  };
});

vi.mock("../services/pre-merge-gate.service.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveMergeGateShas: vi.fn(async () => ({ branchSha: "branch-tip", baseSha: "base-tip" })),
    // A green gate — if the staleness refusal fails to short-circuit, the test would still
    // "pass" the merge, so this must be true for the not-stale assertions to mean anything.
    resolveMergeGate: vi.fn(async () => ({
      passed: true,
      ran: true,
      stage: "verify" as const,
      message: "verify_script passed",
      decision: "run-gate" as const,
    })),
  };
});

const { runPreLockGate } = await import("../services/workspace-merge-gate.js");
const { countBehindCommits } = await import("../services/git.service.js");
const { resolveMergeGate } = await import("../services/pre-merge-gate.service.js");

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

describe("runPreLockGate refuses a badly-stale branch before running the gate (#1169)", () => {
  beforeEach(() => {
    vi.mocked(countBehindCommits).mockReset();
    vi.mocked(resolveMergeGate).mockClear();
  });

  it("refuses with a staleness message and never runs the gate when far behind base", async () => {
    vi.mocked(countBehindCommits).mockResolvedValue(15);

    const recorded: string[] = [];
    const recordMergeAttempt = vi.fn(async (_ws: unknown, _eventType: string, body: string) => {
      recorded.push(body);
    });

    await expect(callRunPreLockGate(recordMergeAttempt)).rejects.toThrow(/Pre-merge gate failed/);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toContain("15 commits stale");
    expect(recorded[0]).toContain("rebase first");
    expect(resolveMergeGate).not.toHaveBeenCalled();
  });

  it("runs the gate normally when within the staleness threshold", async () => {
    vi.mocked(countBehindCommits).mockResolvedValue(3);

    const result = await callRunPreLockGate(vi.fn(async () => {}));

    expect(resolveMergeGate).toHaveBeenCalled();
    expect(result.kind).not.toBe("run-gate");
  });

  it("falls through to the real gate when staleness cannot be determined (fail-open)", async () => {
    vi.mocked(countBehindCommits).mockRejectedValue(new Error("git spawn failed"));

    const result = await callRunPreLockGate(vi.fn(async () => {}));

    expect(resolveMergeGate).toHaveBeenCalled();
    expect(result.kind).not.toBe("run-gate");
  });
});
