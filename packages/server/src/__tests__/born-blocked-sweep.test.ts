// @covers workspaces.bornBlocked.sweep [recovery, db]
//
// #394, the DB half: the query must FIND a zero-session blocked workspace (nothing else can —
// `reconcileCompletionStates` innerJoins `sessions`), and the sweep must apply each verdict
// without ever launching an agent into a worktree whose setup is known-broken.
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("../db/index.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  const schemaMod = await import("@agentic-kanban/shared/schema");
  const { db } = createTestDb();
  return { db, writeDb: db, rawClient: undefined, rawWriteClient: undefined, schema: schemaMod, withDbRetry: <T>(fn: () => Promise<T>) => fn() };
});

import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import { listBornBlockedWorkspaces, reconcileBornBlockedWorkspaces } from "../startup/born-blocked-reconciler.js";

const OLD = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

async function seed(opts: {
  issueStatus: string;
  workspaceStatus?: string;
  setupState?: string | null;
  withSession?: boolean;
  setupScript?: string | null;
}) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: `p-${projectId.slice(0, 8)}`, repoPath: `/tmp/${projectId}`, repoName: "repo",
    defaultBranch: "main", setupScript: opts.setupScript === undefined ? "pnpm install -r" : opts.setupScript,
    createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: opts.issueStatus, sortOrder: 1, isDefault: false, createdAt: now });
  await db.insert(issues).values({
    id: issueId, issueNumber: 92, title: "born blocked", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: `feature/ak-92-${workspaceId.slice(0, 8)}`, workingDir: `/repo/.worktrees/${workspaceId.slice(0, 8)}`, baseBranch: "main",
    isDirect: false, status: opts.workspaceStatus ?? "blocked", provider: "claude",
    latestSetupState: opts.setupState === undefined ? "failed" : opts.setupState,
    latestSetupEndedAt: OLD, createdAt: now, updatedAt: now,
  });
  if (opts.withSession) {
    await db.insert(sessions).values({
      id: randomUUID(), workspaceId, status: "stopped", startedAt: now, createdAt: now,
    });
  }
  return { projectId, issueId, workspaceId };
}

async function statusOf(workspaceId: string): Promise<string> {
  const rows = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return rows[0].status;
}

describe("listBornBlockedWorkspaces (#394)", () => {
  it("finds a blocked workspace with zero sessions", async () => {
    const { workspaceId } = await seed({ issueStatus: "In Review" });
    const found = await listBornBlockedWorkspaces(db);
    expect(found.map((r) => r.workspaceId)).toContain(workspaceId);
  });

  it("ignores a blocked workspace that HAS a session — that one is other reconcilers' business", async () => {
    const { workspaceId } = await seed({ issueStatus: "In Review", withSession: true });
    const found = await listBornBlockedWorkspaces(db);
    expect(found.map((r) => r.workspaceId)).not.toContain(workspaceId);
  });

  it("ignores a workspace that is not blocked", async () => {
    const { workspaceId } = await seed({ issueStatus: "In Review", workspaceStatus: "idle" });
    const found = await listBornBlockedWorkspaces(db);
    expect(found.map((r) => r.workspaceId)).not.toContain(workspaceId);
  });
});

describe("reconcileBornBlockedWorkspaces (#394)", () => {
  it("re-runs the setup script and releases to idle when it now succeeds", async () => {
    const { workspaceId } = await seed({ issueStatus: "In Progress" });
    const calls: string[] = [];
    const result = await reconcileBornBlockedWorkspaces({
      database: db, log: () => {},
      runSetup: async (dir, script) => { calls.push(`${dir}::${script}`); return { exitCode: 0, stderr: "" }; },
    });
    // The sweep is board-wide, so assert on THIS workspace's worktree rather than the whole call
    // list — other rows seeded by sibling tests share the sweep.
    expect(calls).toContain(`/repo/.worktrees/${workspaceId.slice(0, 8)}::pnpm install -r`);
    expect(result.retriedAndReleased).toContain(workspaceId);
    expect(await statusOf(workspaceId)).toBe("idle");
  });

  it("stays blocked when setup fails again — but restamps the verdict so it is not five days old", async () => {
    const { workspaceId } = await seed({ issueStatus: "In Progress" });
    const result = await reconcileBornBlockedWorkspaces({
      database: db, log: () => {},
      runSetup: async () => ({ exitCode: 1, stderr: "ERR_PNPM_FETCH_404" }),
    });
    expect(result.held).toContain(workspaceId);
    expect(await statusOf(workspaceId)).toBe("blocked");
    const rows = await db.select({
      state: workspaces.latestSetupState, endedAt: workspaces.latestSetupEndedAt, tail: workspaces.latestSetupStderrTail,
    }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(rows[0].state).toBe("failed");
    expect(rows[0].endedAt).not.toBe(OLD);
    expect(rows[0].tail).toContain("ERR_PNPM_FETCH_404");
  });

  it("treats a thrown setup runner as a failure rather than crashing the sweep", async () => {
    const { workspaceId } = await seed({ issueStatus: "In Progress" });
    const result = await reconcileBornBlockedWorkspaces({
      database: db, log: () => {},
      runSetup: async () => { throw new Error("spawn ENOENT"); },
    });
    expect(result.held).toContain(workspaceId);
    expect(await statusOf(workspaceId)).toBe("blocked");
  });

  it("closes a blocked workspace whose issue is Done, without running anything", async () => {
    const { workspaceId } = await seed({ issueStatus: "Done" });
    // Assert on THIS worktree, not on "nothing ran at all" — the sweep is board-wide and other
    // tests' rows share it.
    const ranIn: string[] = [];
    const result = await reconcileBornBlockedWorkspaces({
      database: db, log: () => {},
      runSetup: async (dir) => { ranIn.push(dir); return { exitCode: 0, stderr: "" }; },
    });
    expect(ranIn).not.toContain(`/repo/.worktrees/${workspaceId.slice(0, 8)}`);
    expect(result.closed).toContain(workspaceId);
    expect(await statusOf(workspaceId)).toBe("closed");
  });

  it("releases a workspace blocked with no recorded setup failure, without running anything", async () => {
    const { workspaceId } = await seed({ issueStatus: "In Progress", setupState: null });
    const ranIn: string[] = [];
    const result = await reconcileBornBlockedWorkspaces({
      database: db, log: () => {},
      runSetup: async (dir) => { ranIn.push(dir); return { exitCode: 0, stderr: "" }; },
    });
    expect(ranIn).not.toContain(`/repo/.worktrees/${workspaceId.slice(0, 8)}`);
    expect(result.released).toContain(workspaceId);
    expect(await statusOf(workspaceId)).toBe("idle");
  });
});
