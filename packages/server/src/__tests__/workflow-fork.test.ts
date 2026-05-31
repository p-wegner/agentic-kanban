import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import {
  initWorkspaceWorkflow,
  proposeTransition,
  resolveTemplateForIssue,
} from "@agentic-kanban/shared/lib/workflow-engine";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { ensureBuiltinSkills } from "../db/seed.js";
import { ensureBuiltinWorkflows } from "../db/builtin-workflows.js";
import { createWorkflowForkService } from "../services/workflow-fork.service.js";

async function seedProject(db: TestDb) {
  const projectId = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.projects).values({
    id: projectId, name: "Test", repoPath: "/tmp/repo", defaultBranch: "main", createdAt: now, updatedAt: now,
  } as any);
  const statusIds: Record<string, string> = {};
  let sort = 0;
  for (const name of ["Todo", "In Progress", "In Review", "Done"]) {
    const id = randomUUID();
    statusIds[name] = id;
    await db.insert(schema.projectStatuses).values({ id, projectId, name, sortOrder: sort++, isDefault: name === "Todo", createdAt: now });
  }
  return { projectId, statusIds };
}

describe("workflow fork/join orchestration", () => {
  let db: TestDb;
  let startSession: ReturnType<typeof vi.fn>;
  let stopSession: ReturnType<typeof vi.fn>;
  let gitMock: any;
  let svc: ReturnType<typeof createWorkflowForkService>;

  beforeEach(async () => {
    ({ db } = createTestDb());
    await ensureBuiltinSkills(db as any);
    await ensureBuiltinWorkflows(db as any);
    startSession = vi.fn(async () => "sess-" + randomUUID());
    stopSession = vi.fn(async () => {});
    gitMock = {
      createWorktree: vi.fn(async (_repo: string, branch: string) => `/fake/${branch}`),
      getDiff: vi.fn(async () => "diff --git a/x b/x\n+hello"),
      getDiffFromRepo: vi.fn(async () => ""),
      removeWorktree: vi.fn(async () => {}),
    };
    svc = createWorkflowForkService({
      database: db as any,
      getSessionManager: () => ({ startSession, stopSession }) as any,
      gitService: gitMock,
    });
  });

  async function setupForkAtSplit() {
    const { projectId, statusIds } = await seedProject(db);
    const templateId = (await resolveTemplateForIssueByKey(db, projectId, "parallel-review"))!;
    const issueId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(schema.issues).values({
      id: issueId, issueNumber: 1, title: "Parallel demo", issueType: "task", priority: "medium",
      sortOrder: 0, statusId: statusIds["Todo"], projectId, workflowTemplateId: templateId, createdAt: now, updatedAt: now,
    });
    const parentId = randomUUID();
    await db.insert(schema.workspaces).values({
      id: parentId, issueId, branch: "feature/demo", workingDir: "/fake/feature/demo", baseBranch: "main",
      status: "active", createdAt: now, updatedAt: now,
    });
    await initWorkspaceWorkflow(db as any, { workspaceId: parentId, issueId });
    // Implement -> Split Reviews (fork)
    const r = await proposeTransition(db as any, { workspaceId: parentId, toNodeName: "Split Reviews" });
    expect(r.ok).toBe(true);
    return { projectId, statusIds, issueId, parentId };
  }

  it("spawns one child per fork edge with worktrees + sessions", async () => {
    const { parentId } = await setupForkAtSplit();
    await svc.onWorkspaceEnteredNode(parentId);

    const children = await db.select().from(schema.workspaces).where(eq(schema.workspaces.parentWorkspaceId, parentId));
    expect(children.length).toBe(2);
    expect(children.every((c) => c.forkStatus === "running")).toBe(true);
    expect(gitMock.createWorktree).toHaveBeenCalledTimes(2);
    expect(startSession).toHaveBeenCalledTimes(2);
    const names = await Promise.all(
      children.map(async (c) => (await db.select().from(schema.workflowNodes).where(eq(schema.workflowNodes.id, c.currentNodeId!)))[0].name),
    );
    expect(names.sort()).toEqual(["Correctness Review", "Security Review"]);
  });

  it("consolidates into the parent join node once all children join", async () => {
    const { parentId, statusIds, issueId } = await setupForkAtSplit();
    await svc.onWorkspaceEnteredNode(parentId);
    startSession.mockClear();

    const children = await db.select().from(schema.workspaces).where(eq(schema.workspaces.parentWorkspaceId, parentId));
    // Each child reaches the join.
    for (const child of children) {
      const t = await proposeTransition(db as any, { workspaceId: child.id, toNodeName: "Consolidate" });
      expect(t.ok).toBe(true);
      await svc.onWorkspaceEnteredNode(child.id);
    }

    // Parent advanced to the join node "Consolidate"
    const parent = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, parentId)))[0];
    const joinNode = (await db.select().from(schema.workflowNodes).where(eq(schema.workflowNodes.id, parent.currentNodeId!)))[0];
    expect(joinNode.name).toBe("Consolidate");

    // Issue status synced to the join's statusName (In Review) and currentNode set.
    const issue = (await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)))[0];
    expect(issue.statusId).toBe(statusIds["In Review"]);
    expect(issue.currentNodeId).toBe(parent.currentNodeId);

    // Children marked joined + closed; their worktrees cleaned up.
    const after = await db.select().from(schema.workspaces).where(eq(schema.workspaces.parentWorkspaceId, parentId));
    expect(after.every((c) => c.forkStatus === "joined")).toBe(true);
    expect(gitMock.removeWorktree).toHaveBeenCalledTimes(2);
    // Parent join session launched.
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it("marks a failed child launch and still consolidates after the remaining child joins", async () => {
    const { parentId, issueId, statusIds } = await setupForkAtSplit();
    gitMock.createWorktree.mockImplementationOnce(async () => {
      throw new Error("worktree failed");
    });

    await svc.onWorkspaceEnteredNode(parentId);

    const children = await db.select().from(schema.workspaces).where(eq(schema.workspaces.parentWorkspaceId, parentId));
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.forkStatus).sort()).toEqual(["failed", "running"]);
    expect(startSession).toHaveBeenCalledTimes(1);

    const runningChild = children.find((c) => c.forkStatus === "running")!;
    const t = await proposeTransition(db as any, { workspaceId: runningChild.id, toNodeName: "Consolidate" });
    expect(t.ok).toBe(true);
    await svc.onWorkspaceEnteredNode(runningChild.id);

    const parent = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, parentId)))[0];
    const joinNode = (await db.select().from(schema.workflowNodes).where(eq(schema.workflowNodes.id, parent.currentNodeId!)))[0];
    expect(joinNode.name).toBe("Consolidate");

    const issue = (await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)))[0];
    expect(issue.statusId).toBe(statusIds["In Review"]);

    const after = await db.select().from(schema.workspaces).where(eq(schema.workspaces.parentWorkspaceId, parentId));
    expect(after.map((c) => c.forkStatus).sort()).toEqual(["failed", "joined"]);
    expect(startSession).toHaveBeenCalledTimes(2);
  });

  it("launches the attached spec phase skill when entering a spec-driven phase", async () => {
    const { projectId, statusIds } = await seedProject(db);
    const repoPath = await mkdtemp(join(tmpdir(), "ak-spec-repo-"));
    await db.update(schema.projects).set({ repoPath }).where(eq(schema.projects.id, projectId));
    const templateId = (await resolveTemplateForIssueByKey(db, projectId, "spec-driven-phased-planning"))!;
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const now = new Date().toISOString();
    const worktreePath = await mkdtemp(join(tmpdir(), "ak-spec-worktree-"));

    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 2,
      title: "Spec demo",
      issueType: "task",
      priority: "medium",
      sortOrder: 0,
      statusId: statusIds["Todo"],
      projectId,
      workflowTemplateId: templateId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/spec-demo",
      workingDir: worktreePath,
      baseBranch: "main",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await initWorkspaceWorkflow(db as any, { workspaceId, issueId });

    const transition = await proposeTransition(db as any, { workspaceId, toNodeName: "Specify" });
    expect(transition.ok).toBe(true);

    await svc.onWorkspaceEnteredNode(workspaceId);

    expect(startSession).toHaveBeenCalledTimes(1);
    const call = startSession.mock.calls[0][0];
    expect(call.triggerType).toBe("phase:spec-requirements");
    expect(call.prompt).toContain('entered the "Specify" phase');
    expect(call.prompt).toContain("propose_transition");

    const ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)))[0];
    const specifyNode = (await db.select().from(schema.workflowNodes).where(eq(schema.workflowNodes.id, ws.currentNodeId!)))[0];
    expect(specifyNode.skillName).toBe("spec-requirements");
    expect(ws.skillId).toBe(specifyNode.skillId);
  });
});

async function resolveTemplateForIssueByKey(db: TestDb, projectId: string, builtinKey: string): Promise<string | null> {
  const rows = await db.select().from(schema.workflowTemplates).where(eq(schema.workflowTemplates.builtinKey, builtinKey));
  return rows[0]?.id ?? null;
}
