// @covers review-merge.merge.retry-backoff [workflow,state-transition,resilience]
/**
 * #1580 — the worker verify result named 0 suites for a coloured vitest log, and a deterministic red
 * on an unchanged sha was re-gated once the backoff window expired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { parseVerifyFailingSuites } from "../worker/worker-verify-runner.js";
import { escalateVerifyFailedSkip } from "../services/verify-failed-escalation.js";
import { resetAllGateRedFeedbackForTests } from "../services/gate-red-feedback.js";
import { shouldSkipMergeForBackoff } from "../services/merge-backoff.service.js";

const GUARD = "packages/server/src/__tests__/worker-cli-isolation.test.ts";

describe("worker verify parser strips ANSI (#1580)", () => {
  it("names the suite from a coloured FAIL line", () => {
    const log = [
      "\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m  src/__tests__/worker-cli-isolation.test.ts > graph size",
      "\u001b[31mAssertionError: expected 87 to be less than 87\u001b[39m",
      " Test Files  1 failed | 53 passed (54)",
    ].join("\n");
    expect(parseVerifyFailingSuites(log)).toEqual(["src/__tests__/worker-cli-isolation.test.ts"]);
  });
});

describe("a deterministic red is not re-gated on the same sha (#1580)", () => {
  beforeEach(() => {
    resetAllGateRedFeedbackForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("sends the turn once, then keeps skipping after the window; a new head resumes", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const projectId = randomUUID(), statusId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
    await db.insert(projects).values({ id: projectId, name: "T", repoPath: "/repo", repoName: "repo", defaultBranch: "master", createdAt: now, updatedAt: now });
    await db.insert(projectStatuses).values({ id: statusId, projectId, name: "AI Reviewed", sortOrder: 2, isDefault: false, createdAt: now });
    await db.insert(issues).values({ id: issueId, issueNumber: 1551, title: "t", priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now });
    const workingDir = "/repo/.worktrees/ws-1551";
    await db.insert(workspaces).values({ id: workspaceId, issueId, branch: "feature/ak-1551", workingDir, baseBranch: "master", isDirect: false, status: "idle", readyForMerge: true, mergedAt: null, provider: "claude", createdAt: now, updatedAt: now });

    let head = "sha-1";
    const sendBuilderTurn = vi.fn(async () => ({}));
    const skip = { workspaceId, projectId, workingDir, issueNumber: 1551, reason: `verify_failed: failing suite(s): ${GUARD}`, failedSuites: [GUARD], guardFailure: true };
    const res = await escalateVerifyFailedSkip(skip, { database: db, getBranchHeadSha: async () => head, sendBuilderTurn });
    expect(res.feedbackTurn).toBe(1);
    expect(sendBuilderTurn).toHaveBeenCalledTimes(1);

    const ref = { wsId: workspaceId, projectId, workingDir, issueNumber: 1551 };
    const later = () => new Date(Date.now() + 24 * 3600 * 1000);
    const same = await shouldSkipMergeForBackoff(ref, { database: db, now: later, getBranchHeadSha: async () => head });
    expect(same.skip).toBe(true);

    head = "sha-2";
    const moved = await shouldSkipMergeForBackoff(ref, { database: db, now: later, getBranchHeadSha: async () => head, hasSubstantiveChangeSince: async () => true });
    expect(moved.skip).toBe(false);
  });
});
