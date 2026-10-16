// @covers workspaces.diff.branchGone [git]
//
// #1539: a merged workspace's branch is deleted and workingDir is null, so GET /diff fell
// through to `git diff base...branch` and surfaced git's "unknown revision" as a 500.
// It must be a clean NOT_FOUND (404) instead; unrelated git failures stay errors.

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, workspaces, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createWorkspaceDiffService } from "../services/workspace-diff.service.js";
import type { Database } from "../db/index.js";
import type { GitService } from "../services/workspace-internals.js";

let db: TestDb;
let workspaceId: string;

function svcWith(getDiffFromRepo: () => Promise<string>) {
  return createWorkspaceDiffService({
    database: db as unknown as Database,
    gitService: { getDiffFromRepo } as unknown as GitService,
  });
}

beforeEach(async () => {
  ({ db } = createTestDb());
  const projectId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: "/lead", repoName: "lead", defaultBranch: "master" });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Done", sortOrder: 0 });
  const issueId = randomUUID();
  await db.insert(issues).values({ id: issueId, projectId, statusId, title: "t", issueNumber: 1 });
  workspaceId = randomUUID();
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-1-gone",
    workingDir: null,
    baseBranch: "master",
    status: "closed",
  });
});

describe("diff for a merged workspace whose branch was deleted", () => {
  it("answers NOT_FOUND instead of leaking git's unknown-revision error", async () => {
    const svc = svcWith(async () => {
      throw new Error("git diff master...feature/ak-1-gone failed: fatal: ambiguous argument 'master...feature/ak-1-gone': unknown revision or path not in the working tree.");
    });
    await expect(svc.getWorkspaceDiff(workspaceId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not mask other git failures", async () => {
    const svc = svcWith(async () => {
      throw new Error("fatal: unable to read tree");
    });
    await expect(svc.getWorkspaceDiff(workspaceId)).rejects.not.toMatchObject({ code: "NOT_FOUND" });
  });
});
