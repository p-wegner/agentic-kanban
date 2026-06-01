import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { issueComments, issueDependencies, issues, issueTags, projectStatuses, projects, tags, workspaces } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { autoStartUnblockedDependencyIssue, findAutoStartableDependencyIssue } from "../services/dependency-auto-chain.service.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

async function seedProject(db: TestDb) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "Dependency Project",
    repoPath: "/tmp/dependency-project",
    repoName: "dependency-project",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  const statusIds: Record<string, string> = {};
  for (const [index, name] of ["Backlog", "Todo", "In Progress", "Done"].entries()) {
    const id = randomUUID();
    statusIds[name] = id;
    await db.insert(projectStatuses).values({
      id,
      projectId,
      name,
      sortOrder: index,
      isDefault: name === "Todo",
      createdAt: now,
    });
  }
  return { projectId, statusIds };
}

async function insertIssue(db: TestDb, input: {
  projectId: string;
  statusId: string;
  title: string;
  issueNumber: number;
  sortOrder?: number;
}) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(issues).values({
    id,
    issueNumber: input.issueNumber,
    title: input.title,
    priority: "medium",
    sortOrder: input.sortOrder ?? input.issueNumber,
    statusId: input.statusId,
    projectId: input.projectId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function insertDependency(db: TestDb, issueId: string, dependsOnId: string, type: "depends_on" | "blocked_by" | "child_of") {
  await db.insert(issueDependencies).values({
    id: randomUUID(),
    issueId,
    dependsOnId,
    type,
    createdAt: new Date().toISOString(),
  });
}

async function insertTag(db: TestDb, issueId: string, name: string) {
  const tagId = randomUUID();
  await db.insert(tags).values({
    id: tagId,
    name,
    color: "#6B7280",
    isBuiltin: name === "no-auto-start",
    createdAt: new Date().toISOString(),
  });
  await db.insert(issueTags).values({ id: randomUUID(), issueId, tagId });
}

describe("dependency auto-chain candidate decision", () => {
  it("selects one Todo issue when all depends_on and blocked_by blockers are resolved", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    const completed = await insertIssue(db, { projectId, statusId: statusIds.Done, title: "Complete API", issueNumber: 1 });
    const otherDone = await insertIssue(db, { projectId, statusId: statusIds.Done, title: "Complete UI", issueNumber: 2 });
    const candidate = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Wire feature", issueNumber: 3 });
    await insertDependency(db, candidate, completed, "depends_on");
    await insertDependency(db, candidate, otherDone, "blocked_by");

    const decision = await findAutoStartableDependencyIssue({
      database: db,
      projectId,
      completedIssueId: completed,
      wipLimit: 5,
    });

    expect(decision.reason).toBe("ready");
    expect(decision.candidate?.id).toBe(candidate);
  });

  it("skips the dependent issue while any blocking dependency remains unresolved", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    const completed = await insertIssue(db, { projectId, statusId: statusIds.Done, title: "Complete API", issueNumber: 1 });
    const unfinished = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Unfinished blocker", issueNumber: 2 });
    const candidate = await insertIssue(db, { projectId, statusId: statusIds.Backlog, title: "Follow-up", issueNumber: 3 });
    await insertDependency(db, candidate, completed, "depends_on");
    await insertDependency(db, candidate, unfinished, "blocked_by");

    const decision = await findAutoStartableDependencyIssue({
      database: db,
      projectId,
      completedIssueId: completed,
      wipLimit: 5,
    });

    expect(decision.reason).toBe("no-candidates");
    expect(decision.candidate).toBeNull();
  });

  it("does not select an unblocked issue when WIP is already at the cap", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    const completed = await insertIssue(db, { projectId, statusId: statusIds.Done, title: "Complete API", issueNumber: 1 });
    const candidate = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Follow-up", issueNumber: 2 });
    const inProgress = await insertIssue(db, { projectId, statusId: statusIds["In Progress"], title: "Active work", issueNumber: 3 });
    await insertDependency(db, candidate, completed, "depends_on");
    await db.insert(workspaces).values({
      id: randomUUID(),
      issueId: inProgress,
      branch: "feature/ak-3-active-work",
      workingDir: "/tmp/dependency-project/.worktrees/active",
      baseBranch: "main",
      isDirect: false,
      status: "active",
      provider: "claude",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const decision = await findAutoStartableDependencyIssue({
      database: db,
      projectId,
      completedIssueId: completed,
      wipLimit: 1,
    });

    expect(decision.reason).toBe("wip-limit");
    expect(decision.candidate).toBeNull();
  });

  it("skips a newly unblocked dependent issue tagged no-auto-start", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    const completed = await insertIssue(db, { projectId, statusId: statusIds.Done, title: "Complete API", issueNumber: 1 });
    const candidate = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Manual follow-up", issueNumber: 2 });
    await insertDependency(db, candidate, completed, "depends_on");
    await insertTag(db, candidate, "no-auto-start");

    const decision = await findAutoStartableDependencyIssue({
      database: db,
      projectId,
      completedIssueId: completed,
      wipLimit: 5,
    });

    expect(decision.reason).toBe("skip-tag");
    expect(decision.candidate).toBeNull();
  });

  it("does not select candidates participating in a dependency cycle", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    const completed = await insertIssue(db, { projectId, statusId: statusIds.Done, title: "Complete API", issueNumber: 1 });
    const candidate = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Cyclic follow-up", issueNumber: 2 });
    await insertDependency(db, candidate, completed, "depends_on");
    await insertDependency(db, completed, candidate, "depends_on");

    const decision = await findAutoStartableDependencyIssue({
      database: db,
      projectId,
      completedIssueId: completed,
      wipLimit: 5,
    });

    expect(decision.reason).toBe("cycle");
    expect(decision.candidate).toBeNull();
  });

  it("starts an unblocked child issue and records an audit comment", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    const completed = await insertIssue(db, { projectId, statusId: statusIds.Done, title: "Complete parent", issueNumber: 1 });
    const child = await insertIssue(db, { projectId, statusId: statusIds.Backlog, title: "Child task", issueNumber: 2 });
    await insertDependency(db, child, completed, "child_of");
    const createWorkspace = vi.fn(async () => {
      await db.insert(workspaces).values({
        id: "workspace-child",
        issueId: child,
        branch: "feature/ak-2-child-task",
        workingDir: "/tmp/dependency-project/.worktrees/child-task",
        baseBranch: "main",
        isDirect: false,
        status: "active",
        provider: "claude",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return { id: "workspace-child" };
    });

    await autoStartUnblockedDependencyIssue({
      database: db,
      projectId,
      completedIssueId: completed,
      prefMap: new Map([
        ["dependency_auto_chain", "true"],
        ["nudge_wip_limit", "5"],
      ]),
      createWorkspace,
    });

    expect(createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ id: child, issueNumber: 2 }),
      "feature/ak-2-child-task",
    );
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, child));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Auto-started after dependency");
  });
});
