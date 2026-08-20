// @covers startup.handMergedBranchReconciler
//
// Regression for #113: a dev fix landed by hand-merging `feature/ak-<N>` to master WITHOUT
// a board workspace leaves no workspace row to key off, so issue #N never auto-transitions
// to Done. reconcileHandMergedBranches scans the default branch's merge history and
// converges still-open matching issues — while NEVER touching Backlog/terminal issues.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import {
  reconcileHandMergedBranches,
  parseMergedIssueNumbers,
} from "../startup/hand-merged-branch-reconciler.js";
import type { Database } from "../db/index.js";

/** Build a mock getMergeCommits that returns the given subjects, all dated `date` (default: far future, i.e. always newer than any issue's createdAt). */
function mockCommits(subjects: string[], date = "2030-01-01T00:00:00.000Z") {
  return vi.fn(async () => subjects.map((subject) => ({ subject, date })));
}

const noReverts = vi.fn(async () => [] as string[]);

describe("parseMergedIssueNumbers (#113)", () => {
  it("extracts issue numbers from feature/ak-<N> merge subjects in all observed forms", () => {
    const nums = parseMergedIssueNumbers([
      "Merge branch 'feature/ak-105-fix-and-merge-sibling-reconcile'",
      "Merge feature/ak-110-cross-project-sibling-guard",
      "Merge branch 'feature/ak-104-fix-and-merge-stdin-hang'",
      "Merge branch 'ak-7-bare-form'",
    ]);
    expect([...nums].sort((a, b) => a - b)).toEqual([7, 104, 105, 110]);
  });

  it("ignores merge subjects that merely mention a number without the ak- branch prefix", () => {
    const nums = parseMergedIssueNumbers([
      "Merge #112: warn on CLI home-fallback DB split-brain",
      "Merge pull request #99 from somewhere",
      "Merge branch 'feature/some-other-thing'",
    ]);
    expect(nums.size).toBe(0);
  });

  it("extracts only the leading ak-<N> from a slug that mentions a second number later (#146)", () => {
    const nums = parseMergedIssueNumbers(["Merge branch 'feature/ak-105-fix-ak-104-regression'"]);
    expect([...nums]).toEqual([105]);
  });
});

let db: TestDb;
let projectId: string;
const statusIds: Record<string, string> = {};

async function seedIssue(number: number, statusName: string, createdAt?: string): Promise<string> {
  const issueId = randomUUID();
  await db.insert(issues).values({
    id: issueId,
    projectId,
    statusId: statusIds[statusName],
    title: `issue ${number}`,
    issueNumber: number,
    ...(createdAt ? { createdAt } : {}),
  });
  return issueId;
}

async function seedLiveWorkspace(issueId: string): Promise<void> {
  await db.insert(workspaces).values({
    id: randomUUID(),
    issueId,
    branch: "some-branch",
    status: "active",
  });
}

async function statusOf(issueId: string): Promise<string> {
  const [row] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId)).limit(1);
  const name = Object.entries(statusIds).find(([, id]) => id === row.statusId)?.[0];
  return name ?? "?";
}

beforeEach(async () => {
  ({ db } = createTestDb());
  projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "p", repoPath: "/repo", repoName: "repo", defaultBranch: "master",
  });
  for (const [i, name] of ["Backlog", "In Progress", "In Review", "Done", "Cancelled"].entries()) {
    const id = randomUUID();
    statusIds[name] = id;
    await db.insert(projectStatuses).values({ id, projectId, name, sortOrder: i });
  }
});

describe("reconcileHandMergedBranches (#113)", () => {
  it("transitions an open issue whose feature/ak-<N> branch is merged, and only that one", async () => {
    const inProgress = await seedIssue(113, "In Progress");
    const inReview = await seedIssue(114, "In Review");
    const untouched = await seedIssue(200, "In Progress"); // no merged branch

    const getMergeCommits = mockCommits([
      "Merge branch 'feature/ak-113-autoclose-hand-merged'",
      "Merge branch 'feature/ak-114-reconcile-sibling-stamp'",
    ]);

    const count = await reconcileHandMergedBranches({
      database: db as unknown as Database,
      getMergeCommits,
      getRevertedMergeSubjects: noReverts,
    });

    expect(count).toBe(2);
    expect(await statusOf(inProgress)).toBe("Done");
    expect(await statusOf(inReview)).toBe("Done");
    expect(await statusOf(untouched)).toBe("In Progress");
    expect(getMergeCommits).toHaveBeenCalledWith("/repo", "master", expect.any(String));
  });

  it("never transitions a Backlog issue even if a coincidental ak-<N> branch merged", async () => {
    const backlog = await seedIssue(113, "Backlog");
    const getMergeCommits = mockCommits(["Merge branch 'feature/ak-113-something'"]);

    const count = await reconcileHandMergedBranches({
      database: db as unknown as Database,
      getMergeCommits,
      getRevertedMergeSubjects: noReverts,
    });

    expect(count).toBe(0);
    expect(await statusOf(backlog)).toBe("Backlog");
  });

  it("never clobbers a Cancelled issue", async () => {
    const cancelled = await seedIssue(113, "Cancelled");
    const getMergeCommits = mockCommits(["Merge branch 'feature/ak-113-something'"]);

    const count = await reconcileHandMergedBranches({
      database: db as unknown as Database,
      getMergeCommits,
      getRevertedMergeSubjects: noReverts,
    });

    expect(count).toBe(0);
    expect(await statusOf(cancelled)).toBe("Cancelled");
  });

  it("is idempotent — a second run transitions nothing further", async () => {
    const issue = await seedIssue(113, "In Progress");
    const getMergeCommits = mockCommits(["Merge branch 'feature/ak-113-x'"]);

    expect(await reconcileHandMergedBranches({
      database: db as unknown as Database,
      getMergeCommits,
      getRevertedMergeSubjects: noReverts,
    })).toBe(1);
    expect(await reconcileHandMergedBranches({
      database: db as unknown as Database,
      getMergeCommits,
      getRevertedMergeSubjects: noReverts,
    })).toBe(0);
    expect(await statusOf(issue)).toBe("Done");
  });

  it("skips the git scan when the project has no open candidate issues", async () => {
    await seedIssue(113, "Done");
    const getMergeCommits = mockCommits(["Merge branch 'feature/ak-113-x'"]);

    const count = await reconcileHandMergedBranches({
      database: db as unknown as Database,
      getMergeCommits,
      getRevertedMergeSubjects: noReverts,
    });

    expect(count).toBe(0);
    expect(getMergeCommits).not.toHaveBeenCalled();
  });

  // Regression tests for #146: the reconciler once killed THIS ticket mid-work because its
  // number matched an old, unrelated merge commit. Issue numbers RECYCLE — a naive scan of
  // all merge history is unsafe.

  it("never Dones an issue that has a live (non-closed) workspace, even with a matching merged branch", async () => {
    const inFlight = await seedIssue(146, "In Progress");
    await seedLiveWorkspace(inFlight);
    const getMergeCommits = mockCommits(["Merge branch 'feature/ak-146-old-unrelated-fix'"]);

    const count = await reconcileHandMergedBranches({
      database: db as unknown as Database,
      getMergeCommits,
      getRevertedMergeSubjects: noReverts,
    });

    expect(count).toBe(0);
    expect(await statusOf(inFlight)).toBe("In Progress");
  });

  it("never Dones an issue when the matching merge commit predates the issue (recycled number)", async () => {
    const recycled = await seedIssue(146, "In Progress", "2026-07-24T12:00:00.000Z");
    const getMergeCommits = mockCommits(
      ["Merge branch 'feature/ak-146-old-unrelated-fix'"],
      "2020-01-01T00:00:00.000Z",
    );

    const count = await reconcileHandMergedBranches({
      database: db as unknown as Database,
      getMergeCommits,
      getRevertedMergeSubjects: noReverts,
    });

    expect(count).toBe(0);
    expect(await statusOf(recycled)).toBe("In Progress");
  });

  it("Dones an issue when the matching merge commit postdates the issue's creation", async () => {
    const issue = await seedIssue(146, "In Progress", "2020-01-01T00:00:00.000Z");
    const getMergeCommits = mockCommits(
      ["Merge branch 'feature/ak-146-real-fix'"],
      "2026-07-24T12:00:00.000Z",
    );

    const count = await reconcileHandMergedBranches({
      database: db as unknown as Database,
      getMergeCommits,
      getRevertedMergeSubjects: noReverts,
    });

    expect(count).toBe(1);
    expect(await statusOf(issue)).toBe("Done");
  });

  it("Dones only the leading issue number in a double-ak slug, not both", async () => {
    const leading = await seedIssue(105, "In Progress");
    const trailing = await seedIssue(104, "In Progress");
    const getMergeCommits = mockCommits(["Merge branch 'feature/ak-105-fix-ak-104-regression'"]);

    const count = await reconcileHandMergedBranches({
      database: db as unknown as Database,
      getMergeCommits,
      getRevertedMergeSubjects: noReverts,
    });

    expect(count).toBe(1);
    expect(await statusOf(leading)).toBe("Done");
    expect(await statusOf(trailing)).toBe("In Progress");
  });

  it("skips a branch merge that was later reverted", async () => {
    const issue = await seedIssue(146, "In Progress");
    const getMergeCommits = mockCommits(["Merge branch 'feature/ak-146-oops'"]);
    const getRevertedMergeSubjects = vi.fn(async () => ["Revert \"Merge branch 'feature/ak-146-oops'\""]);

    const count = await reconcileHandMergedBranches({
      database: db as unknown as Database,
      getMergeCommits,
      getRevertedMergeSubjects,
    });

    expect(count).toBe(0);
    expect(await statusOf(issue)).toBe("In Progress");
  });
});
