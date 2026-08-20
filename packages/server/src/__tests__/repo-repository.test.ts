// @covers projects.multiRepo.repoSet [data]
//
// Multi-repo repo-set persistence (full-peers model). The `repos` table holds two
// row kinds: project-scoped rows (the project's ADDITIONAL repos; workspaceId NULL)
// and workspace-scoped rows (per-workspace worktree records). The leading repo never
// appears here — an empty list is the single-repo legacy fast path, so the queries
// must keep the two kinds strictly apart.

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, workspaces, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import {
  listProjectRepos,
  listWorkspaceRepos,
  insertProjectRepo,
  updateProjectRepo,
  insertWorkspaceRepo,
  setWorkspaceRepoMergedSha,
  deleteProjectRepo,
} from "../repositories/repo.repository.js";

let db: TestDb;
let projectId: string;
let workspaceId: string;

beforeEach(async () => {
  ({ db } = createTestDb());
  projectId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: "/repo/lead", repoName: "lead" });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Todo", sortOrder: 0 });
  const issueId = randomUUID();
  await db.insert(issues).values({ id: issueId, projectId, statusId, title: "t", issueNumber: 1 });
  workspaceId = randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, issueId, branch: "feature/x" });
});

describe("repo.repository — project-scoped vs workspace-scoped rows", () => {
  it("listProjectRepos returns only project-scoped rows; listWorkspaceRepos only workspace-scoped", async () => {
    await insertProjectRepo({ projectId, path: "/repo/extra", name: "extra", defaultBranch: "main" }, db);
    await insertWorkspaceRepo({
      workspaceId,
      projectId,
      path: "/repo/extra",
      name: "extra",
      worktreePath: "/repo/.worktrees/feature-x",
      branch: "feature/x",
      baseBranch: "main",
      baseCommitSha: "abc123",
    }, db);

    const projectRepos = await listProjectRepos(projectId, db);
    expect(projectRepos).toHaveLength(1);
    expect(projectRepos[0]).toMatchObject({ path: "/repo/extra", defaultBranch: "main", workspaceId: null });

    const wsRepos = await listWorkspaceRepos(workspaceId, db);
    expect(wsRepos).toHaveLength(1);
    expect(wsRepos[0]).toMatchObject({
      workspaceId,
      worktreePath: "/repo/.worktrees/feature-x",
      branch: "feature/x",
      baseBranch: "main",
      baseCommitSha: "abc123",
      mergedHeadSha: null,
    });
  });

  it("a project with no additional repos returns empty lists (single-repo fast path)", async () => {
    expect(await listProjectRepos(projectId, db)).toHaveLength(0);
    expect(await listWorkspaceRepos(workspaceId, db)).toHaveLength(0);
  });

  it("setWorkspaceRepoMergedSha stamps the per-repo merge SHA", async () => {
    await insertWorkspaceRepo({
      workspaceId, projectId, path: "/repo/extra",
      worktreePath: "/wt", branch: "b", baseBranch: "main",
    }, db);
    const [row] = await listWorkspaceRepos(workspaceId, db);
    await setWorkspaceRepoMergedSha(row.id, "deadbeef", db);
    const [updated] = await listWorkspaceRepos(workspaceId, db);
    expect(updated.mergedHeadSha).toBe("deadbeef");
  });

  it("insertWorkspaceRepo persists composeFile onto the workspace-scoped row (#73)", async () => {
    // The per-repo composeFile lives on the project row; it MUST be copied onto the
    // workspace row, because provisioning (resolveExtraComposeFiles) reads it from there
    // at stack-up time. Before #73 it was dropped → sibling stacks never joined.
    await insertWorkspaceRepo({
      workspaceId,
      projectId,
      path: "/repo/extra",
      name: "extra",
      worktreePath: "/repo/.worktrees/feature-x",
      branch: "feature/x",
      baseBranch: "main",
      composeFile: "docker-compose.yml",
    }, db);
    const [row] = await listWorkspaceRepos(workspaceId, db);
    expect(row.composeFile).toBe("docker-compose.yml");
  });

  it("persists + updates per-repo setupScript and composeFile (#71)", async () => {
    const row = await insertProjectRepo(
      { projectId, path: "/repo/extra", setupScript: "pnpm install", composeFile: "docker-compose.yml" },
      db,
    );
    expect(row.setupScript).toBe("pnpm install");
    expect(row.composeFile).toBe("docker-compose.yml");

    const updated = await updateProjectRepo(row.id, { setupScript: "cargo fetch", composeFile: null }, db);
    expect(updated?.setupScript).toBe("cargo fetch");
    expect(updated?.composeFile).toBeNull();

    // Untouched keys are preserved when omitted from the patch.
    const partial = await updateProjectRepo(row.id, { composeFile: "compose.dev.yml" }, db);
    expect(partial?.setupScript).toBe("cargo fetch");
    expect(partial?.composeFile).toBe("compose.dev.yml");

    // name is updatable and leaves other fields untouched (#90).
    const renamed = await updateProjectRepo(row.id, { name: "renamed" }, db);
    expect(renamed?.name).toBe("renamed");
    expect(renamed?.setupScript).toBe("cargo fetch");
    expect(renamed?.composeFile).toBe("compose.dev.yml");
  });

  it("deleteProjectRepo removes only project-scoped rows and reports not-found", async () => {
    const row = await insertProjectRepo({ projectId, path: "/repo/extra" }, db);
    await insertWorkspaceRepo({
      workspaceId, projectId, path: "/repo/extra",
      worktreePath: "/wt", branch: "b", baseBranch: "main",
    }, db);
    expect(await deleteProjectRepo(row.id, projectId, db)).toBe(true);
    expect(await deleteProjectRepo(row.id, projectId, db)).toBe(false);
    // workspace-scoped row untouched
    expect(await listWorkspaceRepos(workspaceId, db)).toHaveLength(1);
  });
});
