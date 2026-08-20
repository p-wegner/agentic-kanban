import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { insertWorkspaceRepo } from "../repositories/repo.repository.js";

// #78: HANDOFF.md must fold in sibling-repo changes for a multi-repo workspace. Mock git.service
// so the diff probes are deterministic per worktree path; listWorkspaceRepos + session rows use
// the real test DB.
vi.mock("../services/git.service.js", () => ({
  getLatestCommit: vi.fn(async () => ({ sha: "abc1234", message: "leading commit" })),
  getDiffShortstat: vi.fn(),
  getChangedFileNames: vi.fn(),
}));

import { getDiffShortstat, getChangedFileNames } from "../services/git.service.js";
import { generateHandoff } from "../services/handoff.service.js";

const mockShortstat = vi.mocked(getDiffShortstat);
const mockChanged = vi.mocked(getChangedFileNames);

async function seedWorkspace(db: TestDb) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(schema.projects).values({ id: projectId, name: "T", repoPath: "/repo", defaultBranch: "main", createdAt: now, updatedAt: now } as any);
  await db.insert(schema.projectStatuses).values({ id: statusId, projectId, name: "In Progress", sortOrder: 1, isDefault: false, createdAt: now });
  await db.insert(schema.issues).values({ id: issueId, issueNumber: 1, title: "i", issueType: "bug", priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now });
  await db.insert(schema.workspaces).values({ id: workspaceId, issueId, branch: "feature/ak-1-x", status: "active", workingDir: "/repo/wt", baseBranch: "main", createdAt: now, updatedAt: now });
  return { projectId, workspaceId };
}

describe("generateHandoff multi-repo (#78)", () => {
  let db: TestDb;
  beforeEach(() => {
    ({ db } = createTestDb());
    mockShortstat.mockReset();
    mockChanged.mockReset();
  });

  it("folds sibling changed files (namespaced) and sums shortstats into the handoff", async () => {
    const { projectId, workspaceId } = await seedWorkspace(db);
    await insertWorkspaceRepo({ workspaceId, projectId, path: "/auth", name: "auth-svc", worktreePath: "/auth/wt", branch: "feature/ak-1-x", baseBranch: "main" }, db);

    mockShortstat.mockImplementation(async (dir: string) =>
      dir === "/repo/wt" ? { filesChanged: 1, insertions: 5, deletions: 0 }
      : dir === "/auth/wt" ? { filesChanged: 2, insertions: 10, deletions: 3 }
      : null);
    mockChanged.mockImplementation(async (dir: string) =>
      dir === "/repo/wt" ? ["src/index.ts"]
      : dir === "/auth/wt" ? ["src/server.js"]
      : []);

    const md = await generateHandoff("/repo/wt", randomUUID(), db, "main", workspaceId);

    // Leading file un-namespaced, sibling file namespaced.
    expect(md).toContain("`src/index.ts`");
    expect(md).toContain("`auth-svc::src/server.js`");
    // Shortstats summed: 1+2 files, 5+10 insertions, 0+3 deletions.
    expect(md).toContain("3 file(s), +15 / -3");
  });

  it("stays leading-only when no workspaceId is provided (back-compat)", async () => {
    const { projectId, workspaceId } = await seedWorkspace(db);
    await insertWorkspaceRepo({ workspaceId, projectId, path: "/auth", name: "auth-svc", worktreePath: "/auth/wt", branch: "feature/ak-1-x", baseBranch: "main" }, db);
    mockShortstat.mockImplementation(async (dir: string) => (dir === "/repo/wt" ? { filesChanged: 1, insertions: 5, deletions: 0 } : { filesChanged: 9, insertions: 9, deletions: 9 }));
    mockChanged.mockImplementation(async (dir: string) => (dir === "/repo/wt" ? ["src/index.ts"] : ["should-not-appear.js"]));

    const md = await generateHandoff("/repo/wt", randomUUID(), db /* no workspaceId */);
    expect(md).toContain("`src/index.ts`");
    expect(md).not.toContain("should-not-appear.js");
  });
});
