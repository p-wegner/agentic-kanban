// #1205: isWorkspaceBranchFullyContained — the git-touching half of the terminal-move
// guard fix. A branch with 0 commits ahead of its base (including the pure empty-branch
// case) has provably nothing left to merge, so `issue move Done` / PATCH / bulk update
// must not refuse the move on its account. Unlike the reconciler sweep in
// hand-merged-branch-reconciler.ts, this is invoked only on a DELIBERATE operator/agent
// action (moving an issue to Done) — the human is already asserting completion, so no
// separate evidence gate is required here (mirrors `adoptMainCheckout`'s reasoning).

import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, workspaces, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { isWorkspaceBranchFullyContained } from "../services/branch-containment.service.js";

type TestDb = ReturnType<typeof createTestDb>["db"];

async function seed(db: TestDb, opts: { isDirect?: boolean; branch?: string } = {}) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo", defaultBranch: "master",
    createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Review", sortOrder: 0, createdAt: now });
  await db.insert(issues).values({
    id: issueId, issueNumber: 1205, title: "Contained branch", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId,
    branch: opts.branch ?? "feature/ak-1205-guard",
    workingDir: "/repo/.worktrees/ak-1205",
    baseBranch: "master", isDirect: opts.isDirect ?? false,
    status: "idle", provider: "claude", createdAt: now, updatedAt: now,
  });
  return { workspaceId, issueId, projectId };
}

describe("isWorkspaceBranchFullyContained (#1205)", () => {
  it("is true when the branch tip is an ancestor of base with 0 unique commits", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seed(db);

    const result = await isWorkspaceBranchFullyContained(workspaceId, db, {
      checkAncestor: vi.fn(async () => ({ isAncestor: true as const, branchSha: "sha-b", baseSha: "sha-base" })),
      countCommits: vi.fn(async () => 0),
    });

    expect(result).toBe(true);
  });

  it("is false when the branch has unique commits ahead of base", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seed(db);

    const result = await isWorkspaceBranchFullyContained(workspaceId, db, {
      checkAncestor: vi.fn(async () => ({ isAncestor: true as const, branchSha: "sha-b", baseSha: "sha-base" })),
      countCommits: vi.fn(async () => 1),
    });

    expect(result).toBe(false);
  });

  it("is false when the branch tip is not an ancestor of base", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seed(db);

    const result = await isWorkspaceBranchFullyContained(workspaceId, db, {
      checkAncestor: vi.fn(async () => ({ isAncestor: false as const, branchSha: "sha-b", baseSha: "sha-base" })),
      countCommits: vi.fn(async () => 0),
    });

    expect(result).toBe(false);
  });

  it("is false for a direct workspace (no branch to strand)", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seed(db, { isDirect: true });

    const result = await isWorkspaceBranchFullyContained(workspaceId, db, {
      checkAncestor: vi.fn(async () => ({ isAncestor: true as const, branchSha: "sha-b", baseSha: "sha-base" })),
      countCommits: vi.fn(async () => 0),
    });

    expect(result).toBe(false);
  });

  it("fails closed (false) on a git error", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seed(db);

    const result = await isWorkspaceBranchFullyContained(workspaceId, db, {
      checkAncestor: vi.fn(async () => { throw new Error("git blew up"); }),
    });

    expect(result).toBe(false);
  });

  it("fails closed (false) for a nonexistent workspace", async () => {
    const { db } = createTestDb();
    const result = await isWorkspaceBranchFullyContained(randomUUID(), db);
    expect(result).toBe(false);
  });
});
