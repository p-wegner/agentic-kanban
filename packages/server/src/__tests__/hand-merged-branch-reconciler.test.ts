// @covers startup.handMergedBranchReconciler
//
// Regression for #113: a dev fix landed by hand-merging `feature/ak-<N>` to master WITHOUT
// a board workspace leaves no workspace row to key off, so issue #N never auto-transitions
// to Done. reconcileHandMergedBranches scans the default branch's merge history and
// converges still-open matching issues — while NEVER touching Backlog/terminal issues.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import {
  reconcileHandMergedBranches,
  parseMergedIssueNumbers,
} from "../startup/hand-merged-branch-reconciler.js";
import type { Database } from "../db/index.js";

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
});

let db: TestDb;
let projectId: string;
const statusIds: Record<string, string> = {};

async function seedIssue(number: number, statusName: string): Promise<string> {
  const issueId = randomUUID();
  await db.insert(issues).values({
    id: issueId,
    projectId,
    statusId: statusIds[statusName],
    title: `issue ${number}`,
    issueNumber: number,
  });
  return issueId;
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

    const getMergeSubjects = vi.fn(async () => [
      "Merge branch 'feature/ak-113-autoclose-hand-merged'",
      "Merge branch 'feature/ak-114-reconcile-sibling-stamp'",
    ]);

    const count = await reconcileHandMergedBranches({ database: db as unknown as Database, getMergeSubjects });

    expect(count).toBe(2);
    expect(await statusOf(inProgress)).toBe("Done");
    expect(await statusOf(inReview)).toBe("Done");
    expect(await statusOf(untouched)).toBe("In Progress");
    expect(getMergeSubjects).toHaveBeenCalledWith("/repo", "master");
  });

  it("never transitions a Backlog issue even if a coincidental ak-<N> branch merged", async () => {
    const backlog = await seedIssue(113, "Backlog");
    const getMergeSubjects = vi.fn(async () => ["Merge branch 'feature/ak-113-something'"]);

    const count = await reconcileHandMergedBranches({ database: db as unknown as Database, getMergeSubjects });

    expect(count).toBe(0);
    expect(await statusOf(backlog)).toBe("Backlog");
  });

  it("never clobbers a Cancelled issue", async () => {
    const cancelled = await seedIssue(113, "Cancelled");
    const getMergeSubjects = vi.fn(async () => ["Merge branch 'feature/ak-113-something'"]);

    const count = await reconcileHandMergedBranches({ database: db as unknown as Database, getMergeSubjects });

    expect(count).toBe(0);
    expect(await statusOf(cancelled)).toBe("Cancelled");
  });

  it("is idempotent — a second run transitions nothing further", async () => {
    const issue = await seedIssue(113, "In Progress");
    const getMergeSubjects = vi.fn(async () => ["Merge branch 'feature/ak-113-x'"]);

    expect(await reconcileHandMergedBranches({ database: db as unknown as Database, getMergeSubjects })).toBe(1);
    expect(await reconcileHandMergedBranches({ database: db as unknown as Database, getMergeSubjects })).toBe(0);
    expect(await statusOf(issue)).toBe("Done");
  });

  it("skips the git scan when the project has no open candidate issues", async () => {
    await seedIssue(113, "Done");
    const getMergeSubjects = vi.fn(async () => ["Merge branch 'feature/ak-113-x'"]);

    const count = await reconcileHandMergedBranches({ database: db as unknown as Database, getMergeSubjects });

    expect(count).toBe(0);
    expect(getMergeSubjects).not.toHaveBeenCalled();
  });
});
