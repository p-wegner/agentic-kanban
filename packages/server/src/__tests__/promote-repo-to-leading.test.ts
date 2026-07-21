// @covers projects.multiRepo.promoteLeading [service]
//
// Changing WHICH repo leads a multi-repo project. "Leading" is not a flag — it is which
// repo's identity sits on the `projects` row vs. in the `repos` table. Promoting a sibling
// SWAPS the two atomically and is guarded against open workspaces (their worktrees are tied
// to the current leading).

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, workspaces, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createProjectService, ProjectError } from "../services/project.service.js";
import { insertProjectRepo, listProjectRepos } from "../repositories/repo.repository.js";

let db: TestDb;
let projectId: string;
let statusId: string;

beforeEach(async () => {
  ({ db } = createTestDb());
  projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "p",
    repoPath: "/repo/lead",
    repoName: "lead",
    defaultBranch: "main",
    setupScript: "lead-setup",
    remoteUrl: "https://example.com/lead.git",
  });
  statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Todo", sortOrder: 0 });
});

describe("projectService.promoteRepoToLeading", () => {
  it("swaps the sibling's identity onto the project and demotes the old leading to a sibling", async () => {
    const beta = await insertProjectRepo(
      { projectId, path: "/repo/beta", name: "beta", defaultBranch: "dev", setupScript: "beta-setup" },
      db,
    );
    const svc = createProjectService({ database: db });

    const result = await svc.promoteRepoToLeading(projectId, beta.id);
    expect(result).toMatchObject({ id: projectId, repoName: "beta" });

    // The project row now carries the promoted repo's identity; the stale remote is cleared.
    const [proj] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(proj).toMatchObject({
      repoPath: "/repo/beta",
      repoName: "beta",
      defaultBranch: "dev",
      setupScript: "beta-setup",
      remoteUrl: null,
    });

    // The former leading is now the sole sibling, preserving its own config.
    const siblings = await listProjectRepos(projectId, db);
    expect(siblings).toHaveLength(1);
    expect(siblings[0]).toMatchObject({
      path: "/repo/lead",
      name: "lead",
      defaultBranch: "main",
      setupScript: "lead-setup",
      workspaceId: null,
    });
    // The promoted sibling's old row is gone (it lives on the project row now).
    expect(siblings.some((r) => r.id === beta.id)).toBe(false);
  });

  it("refuses to promote a repo that is not a sibling of the project", async () => {
    const svc = createProjectService({ database: db });
    await expect(svc.promoteRepoToLeading(projectId, randomUUID())).rejects.toBeInstanceOf(ProjectError);
  });

  it("refuses while a non-closed workspace is open (worktrees tied to the current leading)", async () => {
    const beta = await insertProjectRepo({ projectId, path: "/repo/beta", name: "beta" }, db);
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, projectId, statusId, title: "t", issueNumber: 1 });
    await db.insert(workspaces).values({ id: randomUUID(), issueId, branch: "feature/x", status: "active" });

    const svc = createProjectService({ database: db });
    await expect(svc.promoteRepoToLeading(projectId, beta.id)).rejects.toThrow(/leading repo while/i);

    // Nothing changed: the project keeps its original leading and the sibling stays put.
    const [proj] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(proj.repoName).toBe("lead");
    expect(await listProjectRepos(projectId, db)).toHaveLength(1);
  });

  it("promotion succeeds once the blocking workspace is closed", async () => {
    const beta = await insertProjectRepo({ projectId, path: "/repo/beta", name: "beta" }, db);
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, projectId, statusId, title: "t", issueNumber: 1 });
    await db.insert(workspaces).values({ id: randomUUID(), issueId, branch: "feature/x", status: "closed" });

    const svc = createProjectService({ database: db });
    await svc.promoteRepoToLeading(projectId, beta.id);
    const [proj] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(proj.repoName).toBe("beta");
  });
});
