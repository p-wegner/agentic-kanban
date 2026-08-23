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
  // A real, writable temp root (#828). The fixture used to hand the service paths under
  // `/fake` — which on Windows resolves to a top-level dir on the current drive and is created
  // happily, but on POSIX means the filesystem ROOT and fails with EACCES for a non-root
  // user, so every child launch threw and no worktree/session was ever created.
  let fakeRoot: string;
  let startSession: ReturnType<typeof vi.fn>;
  let stopSession: ReturnType<typeof vi.fn>;
  let gitMock: any;
  let svc: ReturnType<typeof createWorkflowForkService>;

  beforeEach(async () => {
    ({ db } = createTestDb());
    fakeRoot = await mkdtemp(join(tmpdir(), "ak-fork-"));
    await ensureBuiltinSkills(db as any);
    await ensureBuiltinWorkflows(db as any);
    startSession = vi.fn(async () => "sess-" + randomUUID());
    stopSession = vi.fn(async () => {});
    gitMock = {
      createWorktree: vi.fn(async (_repo: string, branch: string) => join(fakeRoot, branch)),
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
      id: parentId, issueId, branch: "feature/demo", workingDir: join(fakeRoot, "feature/demo"), baseBranch: "main",
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

  it("#1001: every fork-child prompt explicitly forbids mark_ready_for_merge and points to propose_transition/the join", async () => {
    const { parentId } = await setupForkAtSplit();
    await svc.onWorkspaceEnteredNode(parentId);

    expect(startSession).toHaveBeenCalledTimes(2);
    for (const call of startSession.mock.calls) {
      const prompt = call[0].prompt as string;
      expect(prompt).toContain("FORK CHILD");
      expect(prompt).toContain("Never call `mark_ready_for_merge`");
      expect(prompt).toContain("advance to the join stage");
    }
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

  it("multi-harness-review: fork children launch on their node's agent override, join uses the board default", async () => {
    const { projectId, statusIds } = await seedProject(db);
    const templateId = (await resolveTemplateForIssueByKey(db, projectId, "multi-harness-review"))!;
    const issueId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(schema.issues).values({
      id: issueId, issueNumber: 3, title: "Multi-harness demo", issueType: "task", priority: "medium",
      sortOrder: 0, statusId: statusIds["Todo"], projectId, workflowTemplateId: templateId, createdAt: now, updatedAt: now,
    });
    const parentId = randomUUID();
    await db.insert(schema.workspaces).values({
      id: parentId, issueId, branch: "feature/mh", workingDir: join(fakeRoot, "feature/mh"), baseBranch: "main",
      status: "active", createdAt: now, updatedAt: now,
    });
    await initWorkspaceWorkflow(db as any, { workspaceId: parentId, issueId });
    const r = await proposeTransition(db as any, { workspaceId: parentId, toNodeName: "Split Reviews" });
    expect(r.ok).toBe(true);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await svc.onWorkspaceEnteredNode(parentId);

    // Two reviewers spawned, each on its node-pinned harness.
    expect(startSession).toHaveBeenCalledTimes(2);
    // Per-child launch logs name the resolved provider for each harness override.
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("claude-code"))).toBe(true);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("codex"))).toBe(true);
    const providersByPrompt = new Map<string, string>(
      startSession.mock.calls.map((c: any[]) => [c[0].prompt as string, c[0].provider as string]),
    );
    const providerFor = (marker: string) =>
      [...providersByPrompt.entries()].find(([prompt]) => prompt.includes(marker))?.[1];
    expect(providerFor("Claude Review")).toBe("claude-code");
    expect(providerFor("Codex Review")).toBe("codex");

    // The child workspace rows record the overridden provider.
    const children = await db.select().from(schema.workspaces).where(eq(schema.workspaces.parentWorkspaceId, parentId));
    expect(children.map((c) => c.provider).sort()).toEqual(["claude", "codex"]);

    // Reviewers join → the consolidator launches on the board default (no node override).
    startSession.mockClear();
    for (const child of children) {
      const t = await proposeTransition(db as any, { workspaceId: child.id, toNodeName: "Consolidate & Fix" });
      expect(t.ok).toBe(true);
      await svc.onWorkspaceEnteredNode(child.id);
    }
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession.mock.calls[0][0].provider).toBe("claude-code");
    // Join launch logs the resolved (board-default) provider too.
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("[fork] join") && String(c[0]).includes("claude-code"))).toBe(true);
    logSpy.mockRestore();
  });

  it("multi-harness-plan-review: two fork/join pairs in one template, each consolidated separately", async () => {
    const { projectId, statusIds } = await seedProject(db);
    const templateId = (await resolveTemplateForIssueByKey(db, projectId, "multi-harness-plan-review"))!;
    const issueId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(schema.issues).values({
      id: issueId, issueNumber: 4, title: "Plan+Review demo", issueType: "task", priority: "medium",
      sortOrder: 0, statusId: statusIds["Todo"], projectId, workflowTemplateId: templateId, createdAt: now, updatedAt: now,
    });
    const parentId = randomUUID();
    await db.insert(schema.workspaces).values({
      id: parentId, issueId, branch: "feature/pr", workingDir: join(fakeRoot, "feature/pr"), baseBranch: "main",
      status: "active", createdAt: now, updatedAt: now,
    });
    await initWorkspaceWorkflow(db as any, { workspaceId: parentId, issueId });

    // Prepare -> Split Planning (fork 1)
    expect((await proposeTransition(db as any, { workspaceId: parentId, toNodeName: "Split Planning" })).ok).toBe(true);
    await svc.onWorkspaceEnteredNode(parentId);

    let children = await db.select().from(schema.workspaces).where(eq(schema.workspaces.parentWorkspaceId, parentId));
    expect(children.length).toBe(2);
    // Planner children join -> parent must land on the PLANNING join, not the review join.
    for (const child of children) {
      expect((await proposeTransition(db as any, { workspaceId: child.id, toNodeName: "Consolidate Plan & Implement" })).ok).toBe(true);
      await svc.onWorkspaceEnteredNode(child.id);
    }
    let parent = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, parentId)))[0];
    let node = (await db.select().from(schema.workflowNodes).where(eq(schema.workflowNodes.id, parent.currentNodeId!)))[0];
    expect(node.name).toBe("Consolidate Plan & Implement");
    // First consolidation captured exactly the 2 planner children's diffs.
    expect(gitMock.getDiff.mock.calls.length + gitMock.getDiffFromRepo.mock.calls.length).toBe(2);

    // Join agent "implements", then advances into the second fork.
    expect((await proposeTransition(db as any, { workspaceId: parentId, toNodeName: "Split Reviews" })).ok).toBe(true);
    await svc.onWorkspaceEnteredNode(parentId);

    children = await db.select().from(schema.workspaces).where(eq(schema.workspaces.parentWorkspaceId, parentId));
    expect(children.length).toBe(4);
    const reviewers = children.filter((c) => c.forkStatus === "running");
    expect(reviewers.length).toBe(2);
    for (const child of reviewers) {
      expect((await proposeTransition(db as any, { workspaceId: child.id, toNodeName: "Consolidate & Fix" })).ok).toBe(true);
      await svc.onWorkspaceEnteredNode(child.id);
    }
    parent = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, parentId)))[0];
    node = (await db.select().from(schema.workflowNodes).where(eq(schema.workflowNodes.id, parent.currentNodeId!)))[0];
    expect(node.name).toBe("Consolidate & Fix");
    // Second consolidation only captured the 2 REVIEW children (2 + 2 = 4 diffs total, not 2 + 4).
    expect(gitMock.getDiff.mock.calls.length + gitMock.getDiffFromRepo.mock.calls.length).toBe(4);
  });

  it("caps concurrency via the fork node's maxParallel config (rest queue)", async () => {
    const { parentId } = await setupForkAtSplit();
    // Pin the "Split Reviews" fork node to 1 parallel child.
    const forkNodes = await db.select().from(schema.workflowNodes).where(eq(schema.workflowNodes.name, "Split Reviews"));
    for (const n of forkNodes) {
      const cfg = { ...(n.config ? JSON.parse(n.config) : {}), maxParallel: 1 };
      await db.update(schema.workflowNodes).set({ config: JSON.stringify(cfg) }).where(eq(schema.workflowNodes.id, n.id));
    }
    await svc.onWorkspaceEnteredNode(parentId);

    const children = await db.select().from(schema.workspaces).where(eq(schema.workspaces.parentWorkspaceId, parentId));
    expect(children.map((c) => c.forkStatus).sort()).toEqual(["queued", "running"]);
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it("caps concurrency via the workflow_fork_max_per_workspace setting", async () => {
    const { parentId } = await setupForkAtSplit();
    await db.insert(schema.preferences).values({ key: "workflow_fork_max_per_workspace", value: "1" });
    await svc.onWorkspaceEnteredNode(parentId);

    const children = await db.select().from(schema.workspaces).where(eq(schema.workspaces.parentWorkspaceId, parentId));
    expect(children.map((c) => c.forkStatus).sort()).toEqual(["queued", "running"]);
    expect(startSession).toHaveBeenCalledTimes(1);
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
