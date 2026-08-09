/**
 * #377 — a merge that NOTHING verified has to leave a mark.
 *
 * MEASURED: eight tickets were auto-merged into a project with no `verify_script` and an all-null
 * stack profile. One carried a test that could never pass; master went from 38/38 green to 40 tests
 * with 1 permanently failing, and no signal was produced anywhere — because "no gate configured" and
 * "gate passed" both surfaced as `passed: true` with identical silence.
 *
 * The fix deliberately does NOT block these merges: a library or CLI project with nothing to gate on
 * is a normal, legitimate state, and refusing its merges would be a worse defect than the silence.
 * What was missing was the saying, so that is what is pinned here.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { workspaces } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";

const getLatestIssueCommentByKind = vi.fn();
vi.mock("../repositories/issue-comments.repository.js", () => ({
  getLatestIssueCommentByKind: (...args: unknown[]) => getLatestIssueCommentByKind(...args),
}));

const { recordUnverifiedMergeNote } = await import("../services/workspace-merge-gate.js");

type WorkspaceRow = typeof workspaces.$inferSelect;
const workspace = { id: "ws-1", issueId: "issue-1" } as WorkspaceRow;
const database = {} as Database;

describe("recordUnverifiedMergeNote (#377)", () => {
  const recordMergeAttempt = vi.fn();

  beforeEach(() => {
    getLatestIssueCommentByKind.mockReset();
    getLatestIssueCommentByKind.mockResolvedValue(undefined);
    recordMergeAttempt.mockReset();
    recordMergeAttempt.mockResolvedValue(undefined);
  });

  it("writes a warning note naming the missing verification, machine-readable via the payload", async () => {
    await recordUnverifiedMergeNote({
      workspace,
      gateMessage: "NOT VERIFIED: this project has no verify_script and no smoke check",
      targetBranch: "master",
      database,
      recordMergeAttempt,
    });
    expect(recordMergeAttempt).toHaveBeenCalledTimes(1);
    const [, eventType, body, payload] = recordMergeAttempt.mock.calls[0];
    expect(eventType).toBe("warning");
    expect(body).toContain("WITHOUT verification");
    // The payload is what a later audit greps for — "which merges were never checked?"
    expect(payload).toMatchObject({ mergeReason: "merged_without_verification", gateStage: "none", targetBranch: "master" });
  });

  it("does not repeat itself — the state belongs to the PROJECT, so it recurs on every merge", async () => {
    getLatestIssueCommentByKind.mockResolvedValue({
      payload: JSON.stringify({ mergeReason: "merged_without_verification" }),
    });
    await recordUnverifiedMergeNote({
      workspace, gateMessage: "m", targetBranch: "master", database, recordMergeAttempt,
    });
    expect(recordMergeAttempt).not.toHaveBeenCalled();
  });

  it("still records when the last note was about something else", async () => {
    getLatestIssueCommentByKind.mockResolvedValue({
      payload: JSON.stringify({ mergeReason: "pre_merge_gate_failed" }),
    });
    await recordUnverifiedMergeNote({
      workspace, gateMessage: "m", targetBranch: "master", database, recordMergeAttempt,
    });
    expect(recordMergeAttempt).toHaveBeenCalledTimes(1);
  });

  it("is non-fatal: an unrecordable note must never be the thing that stops a merge", async () => {
    getLatestIssueCommentByKind.mockRejectedValue(new Error("db gone"));
    await expect(recordUnverifiedMergeNote({
      workspace, gateMessage: "m", targetBranch: "master", database, recordMergeAttempt,
    })).resolves.toBeUndefined();
  });
});
