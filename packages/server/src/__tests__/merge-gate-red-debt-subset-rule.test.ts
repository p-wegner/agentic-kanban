/**
 * #915 — the red-debt subset rule wired into the REAL merge gate (`runPreLockGate`). A known-red
 * suite (already in the project's open ledger) no longer blocks a `fast`/`sprint` train; a NEW
 * red suite — one the ledger has never seen — still blocks it, and the withheld message names it.
 *
 * This is the integration-level counterpart to the pure-function tests in
 * `packages/shared/__tests__/red-debt-gate.test.ts` and `red-debt-cap.test.ts` — those prove the
 * decision function; this proves it is actually consulted by `runPreLockGate` with the right
 * inputs (posture pref, ledger snapshot, base-health failed-suite list) and actually short-circuits
 * the withhold.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Database } from "../db/index.js";
import type { workspaces } from "@agentic-kanban/shared/schema";

vi.mock("../services/pre-merge-gate.service.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveMergeGateShas: vi.fn(async () => ({ branchSha: "branch-tip", baseSha: "base-tip" })),
    resolveMergeGate: vi.fn(async () => ({
      passed: false,
      ran: true,
      stage: "verify" as const,
      message: "verify_script failed (exit 1): 2 suite(s) failed",
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

vi.mock("../repositories/preferences.repository.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getPreference: vi.fn(async () => null),
  };
});

vi.mock("../repositories/red-debt.repository.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    listRedDebt: vi.fn(async () => []),
    openRedDebtEntry: vi.fn(async () => undefined),
  };
});

const { runPreLockGate } = await import("../services/workspace-merge-gate.js");
const { getBaseBranchHealthAtMergeBase } = await import("../services/base-branch-health.service.js");
const { getPreference } = await import("../repositories/preferences.repository.js");
const { listRedDebt, openRedDebtEntry } = await import("../repositories/red-debt.repository.js");

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

function mockBaseHealthFailedSuites(suites: string[]) {
  vi.mocked(getBaseBranchHealthAtMergeBase).mockResolvedValue({
    mergeBaseSha: "base-tip",
    recordedSha: "base-tip",
    health: {
      id: "row-1",
      projectId: "project-1",
      sha: "base-tip",
      branch: "master",
      outcome: "red",
      durationMs: 1000,
      message: "known suites red on master",
      failedSuites: JSON.stringify(suites),
      createdAt: new Date().toISOString(),
    },
  } as never);
}

/** `getPreference` is keyed, so return per-key canned values instead of one flat mock. */
function stubPreferences(values: Record<string, string | null>) {
  vi.mocked(getPreference).mockImplementation(async (key: string) => values[key] ?? null);
}

describe("runPreLockGate applies the red-debt subset rule (#915)", () => {
  beforeEach(() => {
    vi.mocked(getBaseBranchHealthAtMergeBase).mockReset();
    vi.mocked(getPreference).mockReset();
    vi.mocked(listRedDebt).mockReset();
    vi.mocked(openRedDebtEntry).mockReset();
    stubPreferences({});
    vi.mocked(listRedDebt).mockResolvedValue([]);
    vi.mocked(openRedDebtEntry).mockResolvedValue(undefined as never);
  });

  it("passes with debt under `fast` when every failing suite is already ledgered", async () => {
    mockBaseHealthFailedSuites(["suite-a", "suite-b"]);
    stubPreferences({ "red_debt_posture_project-1": "fast" });
    vi.mocked(listRedDebt).mockResolvedValue([
      { id: "d1", projectId: "project-1", suite: "suite-a", sinceCommit: "c1", attributedIssueId: null, ownerIssueId: null, tag: "real", openedAt: new Date().toISOString(), closedAt: null } as never,
      { id: "d2", projectId: "project-1", suite: "suite-b", sinceCommit: "c1", attributedIssueId: null, ownerIssueId: null, tag: "flaky", openedAt: new Date().toISOString(), closedAt: null } as never,
    ]);

    const recordMergeAttempt = vi.fn(async () => {});
    const result = await callRunPreLockGate(recordMergeAttempt);

    expect(result).toEqual(RUN_GATE_TOKEN);
    expect(recordMergeAttempt).not.toHaveBeenCalled();
    expect(openRedDebtEntry).not.toHaveBeenCalled();
  });

  it("still withholds under `fast` when a failing suite is NOT in the ledger, and names it", async () => {
    mockBaseHealthFailedSuites(["suite-a", "suite-new"]);
    stubPreferences({ "red_debt_posture_project-1": "fast" });
    vi.mocked(listRedDebt).mockResolvedValue([
      { id: "d1", projectId: "project-1", suite: "suite-a", sinceCommit: "c1", attributedIssueId: null, ownerIssueId: null, tag: "real", openedAt: new Date().toISOString(), closedAt: null } as never,
    ]);

    const recorded: string[] = [];
    const recordMergeAttempt = vi.fn(async (_ws: unknown, _eventType: string, body: string) => {
      recorded.push(body);
    });

    await expect(callRunPreLockGate(recordMergeAttempt)).rejects.toThrow(/Pre-merge gate failed/);
    expect(recorded).toHaveLength(1);
    // The gate message is preserved even though the subset check did not soften the verdict.
    expect(recorded[0]).toContain("verify_script failed");
    expect(openRedDebtEntry).not.toHaveBeenCalled();
  });

  it("ledgers a new red suite and passes under `sprint`, opening a debt entry for it", async () => {
    mockBaseHealthFailedSuites(["suite-a", "suite-new"]);
    stubPreferences({ "red_debt_posture_project-1": "sprint" });
    vi.mocked(listRedDebt).mockResolvedValue([
      { id: "d1", projectId: "project-1", suite: "suite-a", sinceCommit: "c1", attributedIssueId: null, ownerIssueId: null, tag: "real", openedAt: new Date().toISOString(), closedAt: null } as never,
    ]);

    const recordMergeAttempt = vi.fn(async () => {});
    const result = await callRunPreLockGate(recordMergeAttempt);

    expect(result).toEqual(RUN_GATE_TOKEN);
    expect(recordMergeAttempt).not.toHaveBeenCalled();
    expect(openRedDebtEntry).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", suite: "suite-new", tag: "real" }),
      expect.anything(),
    );
  });

  it("does not soften the verdict under `standard` even when the failing set is fully ledgered", async () => {
    mockBaseHealthFailedSuites(["suite-a"]);
    stubPreferences({ "red_debt_posture_project-1": "standard" });
    vi.mocked(listRedDebt).mockResolvedValue([
      { id: "d1", projectId: "project-1", suite: "suite-a", sinceCommit: "c1", attributedIssueId: null, ownerIssueId: null, tag: "real", openedAt: new Date().toISOString(), closedAt: null } as never,
    ]);

    const recordMergeAttempt = vi.fn(async () => {});
    await expect(callRunPreLockGate(recordMergeAttempt)).rejects.toThrow(/Pre-merge gate failed/);
    expect(openRedDebtEntry).not.toHaveBeenCalled();
  });
});
