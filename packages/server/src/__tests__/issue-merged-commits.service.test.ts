import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import type { CommitInfo } from "@agentic-kanban/shared/lib/git-service";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createIssueMergedCommitsService } from "../services/issue-merged-commits.service.js";
import type { GitService } from "../services/workspace-internals.js";

let db: TestDb;
let projectId: string;
let statusId: string;

function makeFakeGit(byBranch: Record<string, CommitInfo[]>): GitService {
  return {
    async getCommitsForBranch(_repoPath: string, _baseRef: string, branch: string) {
      return byBranch[branch] ?? [];
    },
  } as unknown as GitService;
}

async function createIssue(): Promise<string> {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  await db.insert(schema.issues).values({
    id: issueId,
    issueNumber: Math.floor(Math.random() * 1e9),
    title: "Test Issue",
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  return issueId;
}

beforeAll(async () => {
  db = createTestDb().db;
  const now = new Date().toISOString();
  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "Test Project",
    repoPath: "/tmp/test",
    repoName: "test",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });
  statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "Done",
    sortOrder: 4,
    isDefault: false,
    createdAt: now,
  });
});

describe("createIssueMergedCommitsService", () => {
  it("returns null for an unknown issue", async () => {
    const service = createIssueMergedCommitsService({ database: db, gitService: makeFakeGit({}) });
    expect(await service.getMergedCommits(randomUUID())).toBeNull();
  });

  it("returns merged:false with empty commits when no workspace is merged", async () => {
    const issueId = await createIssue();
    const now = new Date().toISOString();
    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      issueId,
      branch: "feature/ak-1-foo",
      baseBranch: "master",
      baseCommitSha: "base000",
      status: "active",
      mergedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const service = createIssueMergedCommitsService({ database: db, gitService: makeFakeGit({}) });
    const result = await service.getMergedCommits(issueId);
    expect(result).toEqual({ merged: false, defaultBranch: "master", commits: [] });
  });

  it("lists commits for a merged workspace, newest first, with branch + workspaceId", async () => {
    const issueId = await createIssue();
    const now = new Date().toISOString();
    const wsId = randomUUID();
    await db.insert(schema.workspaces).values({
      id: wsId,
      issueId,
      branch: "feature/ak-2-bar",
      baseBranch: "master",
      baseCommitSha: "base111",
      status: "closed",
      mergedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const fakeGit = makeFakeGit({
      "feature/ak-2-bar": [
        { sha: "aaa", shortSha: "aaa", author: "Alice", date: "2026-06-01T10:00:00Z", message: "older" },
        { sha: "bbb", shortSha: "bbb", author: "Bob", date: "2026-06-02T10:00:00Z", message: "newer" },
      ],
    });
    const service = createIssueMergedCommitsService({ database: db, gitService: fakeGit });
    const result = await service.getMergedCommits(issueId);
    expect(result!.merged).toBe(true);
    expect(result!.commits.map((c) => c.sha)).toEqual(["bbb", "aaa"]);
    expect(result!.commits[0]).toMatchObject({ branch: "feature/ak-2-bar", workspaceId: wsId });
  });

  it("de-duplicates commits across multiple merged workspaces", async () => {
    const issueId = await createIssue();
    const now = new Date().toISOString();
    await db.insert(schema.workspaces).values([
      {
        id: randomUUID(), issueId, branch: "branch-a", baseBranch: "master", baseCommitSha: "b1",
        status: "closed", mergedAt: now, createdAt: now, updatedAt: now,
      },
      {
        id: randomUUID(), issueId, branch: "branch-b", baseBranch: "master", baseCommitSha: "b2",
        status: "closed", mergedAt: now, createdAt: now, updatedAt: now,
      },
    ]);
    const shared = { sha: "shared", shortSha: "shared", author: "X", date: "2026-06-01T00:00:00Z", message: "shared" };
    const fakeGit = makeFakeGit({
      "branch-a": [shared, { sha: "only-a", shortSha: "only-a", author: "X", date: "2026-06-03T00:00:00Z", message: "a" }],
      "branch-b": [shared, { sha: "only-b", shortSha: "only-b", author: "X", date: "2026-06-02T00:00:00Z", message: "b" }],
    });
    const service = createIssueMergedCommitsService({ database: db, gitService: fakeGit });
    const result = await service.getMergedCommits(issueId);
    const shas = result!.commits.map((c) => c.sha).sort();
    expect(shas).toEqual(["only-a", "only-b", "shared"]);
  });

  it("ignores direct workspaces (no feature branch to diff)", async () => {
    const issueId = await createIssue();
    const now = new Date().toISOString();
    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      issueId,
      branch: "master",
      baseBranch: null,
      isDirect: true,
      status: "closed",
      mergedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const service = createIssueMergedCommitsService({
      database: db,
      gitService: makeFakeGit({ master: [{ sha: "z", shortSha: "z", author: "X", date: "2026-06-01T00:00:00Z", message: "z" }] }),
    });
    const result = await service.getMergedCommits(issueId);
    expect(result).toEqual({ merged: false, defaultBranch: "master", commits: [] });
  });
});
