// @covers workspaces.multiRepo.aggregateDiff [git]
//
// Multi-repo aggregate diff: GET /diff concatenates each sibling repo's diff into
// the top-level `diff` (so review sees the combined change set wire-compatibly)
// and adds per-repo `repos[]` sections; sibling conflicts merge into the top-level
// conflicts. A single-repo workspace (no `repos` rows) must return a response with
// NO `repos` field and untouched diff — the zero-regression contract.

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, workspaces, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { insertWorkspaceRepo } from "../repositories/repo.repository.js";
import { createWorkspaceDiffService } from "../services/workspace-diff.service.js";
import type { Database } from "../db/index.js";
import type { GitService } from "../services/workspace-internals.js";

const LEAD_DIFF = "diff --git a/lead.ts b/lead.ts\n+lead change\n";
const SIBLING_DIFF = "diff --git a/sib.ts b/sib.ts\n+sibling change\n";

function fakeGitService(overrides: Partial<Record<string, unknown>> = {}): GitService {
  return {
    getDiff: async (dir: string) => (dir.includes("sibling") ? SIBLING_DIFF : LEAD_DIFF),
    getDiffFromRepo: async () => "",
    getWorkingTreeDiff: async () => "",
    detectConflicts: async (dir: string) =>
      dir.includes("sibling")
        ? { hasConflicts: true, conflictingFiles: ["sib.ts"] }
        : { hasConflicts: false, conflictingFiles: [] },
    getLatestCommit: async () => null,
    ...overrides,
  } as unknown as GitService;
}

let db: TestDb;
let workspaceId: string;
let projectId: string;

beforeEach(async () => {
  ({ db } = createTestDb());
  projectId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: "/lead", repoName: "lead", defaultBranch: "main" });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Todo", sortOrder: 0 });
  const issueId = randomUUID();
  await db.insert(issues).values({ id: issueId, projectId, statusId, title: "t", issueNumber: 1 });
  workspaceId = randomUUID();
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/x",
    workingDir: "/lead/.worktrees/feature-x",
    baseBranch: "main",
  });
});

describe("multi-repo aggregate diff", () => {
  it("single-repo workspace: no repos field, diff untouched", async () => {
    const svc = createWorkspaceDiffService({ database: db as unknown as Database, gitService: fakeGitService() });
    const result = await svc.getWorkspaceDiff(workspaceId);
    expect(result.diff).toBe(LEAD_DIFF);
    expect("repos" in result).toBe(false);
    expect(result.conflicts).toEqual({ hasConflicts: false, conflictingFiles: [] });
  });

  it("multi-repo workspace: concatenated diff, per-repo sections, merged conflicts", async () => {
    await insertWorkspaceRepo({
      workspaceId,
      projectId,
      path: "/sibling-repo",
      name: "sibling",
      worktreePath: "/sibling-repo/.worktrees/feature-x-sibling",
      branch: "feature/x",
      baseBranch: "main",
    }, db);

    const svc = createWorkspaceDiffService({ database: db as unknown as Database, gitService: fakeGitService() });
    const result = await svc.getWorkspaceDiff(workspaceId) as Awaited<ReturnType<typeof svc.getWorkspaceDiff>> & {
      repos?: Array<{ name: string | null; diff: string }>;
    };

    expect(result.diff).toContain("lead change");
    expect(result.diff).toContain("sibling change");
    expect(result.repos).toHaveLength(2);
    expect(result.repos![0].name).toBeNull();
    expect(result.repos![0].diff).toBe(LEAD_DIFF);
    expect(result.repos![1].name).toBe("sibling");
    expect(result.repos![1].diff).toBe(SIBLING_DIFF);
    // The sibling's conflict surfaces at the top level so merge gating sees it.
    expect(result.conflicts).toEqual({ hasConflicts: true, conflictingFiles: ["sib.ts"] });
  });

  it("getConflicts aggregates sibling repos", async () => {
    await insertWorkspaceRepo({
      workspaceId,
      projectId,
      path: "/sibling-repo",
      name: "sibling",
      worktreePath: "/sibling-repo/.worktrees/feature-x-sibling",
      branch: "feature/x",
      baseBranch: "main",
    }, db);
    const svc = createWorkspaceDiffService({ database: db as unknown as Database, gitService: fakeGitService() });
    const result = await svc.getConflicts(workspaceId);
    expect(result.hasConflicts).toBe(true);
    expect(result.conflictingFiles).toEqual(["sib.ts"]);
  });
});
