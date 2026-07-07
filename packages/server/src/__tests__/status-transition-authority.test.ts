/**
 * #953 — unit tests for the two state-transition authorities:
 *
 *  - transitionIssueStatus (shared/lib/workflow-engine/status-transition.ts):
 *    writes statusId, stamps statusChangedAt, and syncs the workflow current-node
 *    (the divergence bug: raw writers skipping node sync re-broke the #537
 *    end-node dependency check).
 *
 *  - setWorkspaceStatus (repositories/workspace-status.repository.ts):
 *    enforces the terminal invariant — a workspace with status "closed" AND
 *    mergedAt set may not be revived without an explicit force+reason.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { transitionIssueStatus, initWorkspaceWorkflow } from "@agentic-kanban/shared/lib/workflow-engine";
import {
  setTransitionStrictness,
  getTransitionStrictness,
  IllegalStatusTransitionError,
} from "@agentic-kanban/shared/lib/status-transitions";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { ensureBuiltinSkills } from "../db/seed.js";
import { ensureBuiltinWorkflows } from "../db/builtin-workflows.js";
import { setWorkspaceStatus } from "../repositories/workspace-status.repository.js";

async function seedProject(db: TestDb) {
  const projectId = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "Test",
    repoPath: "/tmp/x",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  } as any);
  const statusNames = ["Todo", "In Progress", "In Review", "Done"];
  const statusIds: Record<string, string> = {};
  let sort = 0;
  for (const name of statusNames) {
    const id = randomUUID();
    statusIds[name] = id;
    await db.insert(schema.projectStatuses).values({
      id,
      projectId,
      name,
      sortOrder: sort++,
      isDefault: name === "Todo",
      createdAt: now,
    });
  }
  return { projectId, statusIds };
}

async function seedIssue(db: TestDb, projectId: string, statusId: string) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.issues).values({
    id,
    issueNumber: 953,
    title: "Authority test issue",
    issueType: "bug",
    priority: "medium",
    sortOrder: 0,
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function seedWorkspace(
  db: TestDb,
  issueId: string,
  overrides: Partial<typeof schema.workspaces.$inferInsert> = {},
) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.workspaces).values({
    id,
    issueId,
    branch: "feature/test",
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return id;
}

describe("transitionIssueStatus (#953 issue authority)", () => {
  let db: TestDb;

  beforeEach(async () => {
    ({ db } = createTestDb());
    await ensureBuiltinSkills(db as any);
    await ensureBuiltinWorkflows(db as any);
  });

  it("writes statusId, stamps statusChangedAt, and syncs the workflow node", async () => {
    const { projectId, statusIds } = await seedProject(db);
    const issueId = await seedIssue(db, projectId, statusIds["Todo"]);
    const wsId = await seedWorkspace(db, issueId);
    await initWorkspaceWorkflow(db as any, { workspaceId: wsId, issueId }); // start node = In Progress

    const now = "2026-07-02T10:00:00.000Z";
    await transitionIssueStatus(db as any, issueId, statusIds["In Review"], { now });

    const issue = (await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)))[0];
    expect(issue.statusId).toBe(statusIds["In Review"]);
    expect(issue.statusChangedAt).toBe(now);
    expect(issue.updatedAt).toBe(now);
    // The workflow current-node must follow the status (the #537 divergence class).
    const node = (await db.select().from(schema.workflowNodes).where(eq(schema.workflowNodes.id, issue.currentNodeId!)))[0];
    expect(node.statusName).toBe("In Review");
  });

  it("still writes the status when the issue has no workflow (sync is a no-op)", async () => {
    const { projectId, statusIds } = await seedProject(db);
    const issueId = await seedIssue(db, projectId, statusIds["Todo"]);

    await transitionIssueStatus(db as any, issueId, statusIds["Done"]);

    const issue = (await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)))[0];
    expect(issue.statusId).toBe(statusIds["Done"]);
    expect(issue.statusChangedAt).toBeTruthy();
  });
});

describe("setWorkspaceStatus (#953 workspace authority, terminal invariant)", () => {
  let db: TestDb;
  let issueId: string;

  beforeEach(async () => {
    ({ db } = createTestDb());
    const { projectId, statusIds } = await seedProject(db);
    issueId = await seedIssue(db, projectId, statusIds["Done"]);
  });

  it("blocks reviving a closed+merged workspace (returns false, keeps closed)", async () => {
    const wsId = await seedWorkspace(db, issueId, {
      status: "closed",
      mergedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    for (const target of ["idle", "active"] as const) {
      const ok = await setWorkspaceStatus(db as any, wsId, target);
      expect(ok).toBe(false);
      const ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId)))[0];
      expect(ws.status).toBe("closed");
    }
  });

  it("allows reviving with an explicit force+reason", async () => {
    const wsId = await seedWorkspace(db, issueId, {
      status: "closed",
      mergedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const ok = await setWorkspaceStatus(db as any, wsId, "idle", {
      force: { reason: "test: deliberate revive of a merged workspace" },
    });
    expect(ok).toBe(true);
    const ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId)))[0];
    expect(ws.status).toBe("idle");
  });

  it("allows reviving a closed workspace WITHOUT mergedAt (abandoned close is not terminal)", async () => {
    const wsId = await seedWorkspace(db, issueId, { status: "closed" });

    const ok = await setWorkspaceStatus(db as any, wsId, "idle");
    expect(ok).toBe(true);
    const ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId)))[0];
    expect(ws.status).toBe("idle");
  });

  it("writes status, updatedAt, and extra columns atomically", async () => {
    const wsId = await seedWorkspace(db, issueId, { status: "reviewing", readyForMerge: true, workingDir: "/wt" });
    const now = "2026-07-02T11:00:00.000Z";

    const ok = await setWorkspaceStatus(db as any, wsId, "closed", { now, set: { workingDir: null, readyForMerge: false } });
    expect(ok).toBe(true);
    const ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId)))[0];
    expect(ws.status).toBe("closed");
    expect(ws.updatedAt).toBe(now);
    expect(ws.workingDir).toBeNull();
    expect(ws.readyForMerge).toBe(false);
  });

  it("onlyIfCurrentStatus is a compare-and-set (skips when the status moved on)", async () => {
    const wsId = await seedWorkspace(db, issueId, { status: "active" });

    await setWorkspaceStatus(db as any, wsId, "idle", { onlyIfCurrentStatus: "fixing" });
    const ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId)))[0];
    expect(ws.status).toBe("active");

    await setWorkspaceStatus(db as any, wsId, "idle", { onlyIfCurrentStatus: "active" });
    const ws2 = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId)))[0];
    expect(ws2.status).toBe("idle");
  });
});

/**
 * Legal-transition-table enforcement (arch-review §1.1). The two setters now
 * classify each transition against an explicit legal table and SURFACE illegal
 * ones. Default policy is WARN-AND-ALLOW (illegal transitions log a warning but
 * still apply); STRICT throws. The single truly-never-legal transition —
 * reviving a terminal closed+merged workspace — stays blocked (no-op) under warn
 * and throws under strict.
 */
describe("transition-table enforcement (arch-review §1.1)", () => {
  let db: TestDb;
  const originalStrictness = getTransitionStrictness();

  beforeEach(async () => {
    ({ db } = createTestDb());
    await ensureBuiltinSkills(db as any);
    await ensureBuiltinWorkflows(db as any);
    setTransitionStrictness("warn");
  });

  afterEach(() => {
    setTransitionStrictness(originalStrictness);
    vi.restoreAllMocks();
  });

  async function seedCanonicalProject() {
    const projectId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(schema.projects).values({
      id: projectId,
      name: "Canonical",
      repoPath: "/tmp/x",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    } as any);
    const names = ["Backlog", "Todo", "In Progress", "In Review", "AI Reviewed", "Done", "Cancelled"];
    const statusIds: Record<string, string> = {};
    let sort = 0;
    for (const name of names) {
      const id = randomUUID();
      statusIds[name] = id;
      await db.insert(schema.projectStatuses).values({
        id,
        projectId,
        name,
        sortOrder: sort++,
        isDefault: name === "Todo",
        createdAt: now,
      });
    }
    return { projectId, statusIds };
  }

  const rowFor = async (wsId: string) =>
    (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId)))[0];
  const issueFor = async (issueId: string) =>
    (await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)))[0];

  // ---- setWorkspaceStatus ----

  it("(a) a legal workspace transition applies silently (no illegal-transition warning)", async () => {
    const { projectId, statusIds } = await seedCanonicalProject();
    const issueId = await seedIssue(db, projectId, statusIds["Todo"]);
    const wsId = await seedWorkspace(db, issueId, { status: "active" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ok = await setWorkspaceStatus(db as any, wsId, "idle"); // active -> idle is legal
    expect(ok).toBe(true);
    expect((await rowFor(wsId)).status).toBe("idle");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("illegal transition"))).toBe(false);
  });

  it("(b) an illegal workspace transition warns but still applies under the default warn policy", async () => {
    const { projectId, statusIds } = await seedCanonicalProject();
    const issueId = await seedIssue(db, projectId, statusIds["Todo"]);
    const wsId = await seedWorkspace(db, issueId, { status: "error" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // "error" is only allowed to move to active/idle/blocked/closed — never straight to "reviewing".
    const ok = await setWorkspaceStatus(db as any, wsId, "reviewing");
    expect(ok).toBe(true);
    expect((await rowFor(wsId)).status).toBe("reviewing"); // still applied
    const warned = warn.mock.calls
      .map((c) => String(c[0]))
      .some((m) => m.includes("illegal transition") && m.includes("warn-and-allow"));
    expect(warned).toBe(true);
  });

  it("(c) reviving a terminal closed+merged workspace stays blocked under warn and THROWS under strict", async () => {
    const { projectId, statusIds } = await seedCanonicalProject();
    const issueId = await seedIssue(db, projectId, statusIds["Done"]);
    const wsId = await seedWorkspace(db, issueId, {
      status: "closed",
      mergedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // Default warn policy: existing terminal invariant still no-ops and returns false.
    const ok = await setWorkspaceStatus(db as any, wsId, "idle");
    expect(ok).toBe(false);
    expect((await rowFor(wsId)).status).toBe("closed");

    // Strict policy: the truly-never-legal transition throws.
    setTransitionStrictness("strict");
    await expect(setWorkspaceStatus(db as any, wsId, "idle")).rejects.toBeInstanceOf(
      IllegalStatusTransitionError,
    );
    expect((await rowFor(wsId)).status).toBe("closed");
  });

  it("strict policy also throws on a warn-level illegal workspace transition", async () => {
    const { projectId, statusIds } = await seedCanonicalProject();
    const issueId = await seedIssue(db, projectId, statusIds["Todo"]);
    const wsId = await seedWorkspace(db, issueId, { status: "error" });
    setTransitionStrictness("strict");

    await expect(setWorkspaceStatus(db as any, wsId, "reviewing")).rejects.toBeInstanceOf(
      IllegalStatusTransitionError,
    );
    expect((await rowFor(wsId)).status).toBe("error"); // unchanged
  });

  // ---- transitionIssueStatus ----

  it("(a) a legal issue transition applies silently", async () => {
    const { projectId, statusIds } = await seedCanonicalProject();
    const issueId = await seedIssue(db, projectId, statusIds["Todo"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await transitionIssueStatus(db as any, issueId, statusIds["In Progress"]); // legal
    expect((await issueFor(issueId)).statusId).toBe(statusIds["In Progress"]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("illegal issue transition"))).toBe(false);
  });

  it("(b) an illegal issue transition warns but still applies under the default warn policy", async () => {
    const { projectId, statusIds } = await seedCanonicalProject();
    const issueId = await seedIssue(db, projectId, statusIds["Backlog"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Backlog -> AI Reviewed is not a legal canonical transition.
    await transitionIssueStatus(db as any, issueId, statusIds["AI Reviewed"]);
    expect((await issueFor(issueId)).statusId).toBe(statusIds["AI Reviewed"]); // still applied
    const warned = warn.mock.calls
      .map((c) => String(c[0]))
      .some((m) => m.includes("illegal issue transition") && m.includes("warn-and-allow"));
    expect(warned).toBe(true);
  });

  it("(c) strict policy throws on an illegal issue transition and the write is NOT applied", async () => {
    const { projectId, statusIds } = await seedCanonicalProject();
    const issueId = await seedIssue(db, projectId, statusIds["Backlog"]);
    setTransitionStrictness("strict");

    await expect(
      transitionIssueStatus(db as any, issueId, statusIds["AI Reviewed"]),
    ).rejects.toBeInstanceOf(IllegalStatusTransitionError);
    expect((await issueFor(issueId)).statusId).toBe(statusIds["Backlog"]); // unchanged
  });

  it("a custom (non-canonical) issue status never warns", async () => {
    const projectId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(schema.projects).values({
      id: projectId,
      name: "Custom",
      repoPath: "/tmp/x",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    } as any);
    const fromId = randomUUID();
    const toId = randomUUID();
    await db.insert(schema.projectStatuses).values({ id: fromId, projectId, name: "Intake", sortOrder: 0, isDefault: true, createdAt: now });
    await db.insert(schema.projectStatuses).values({ id: toId, projectId, name: "Shipped", sortOrder: 1, isDefault: false, createdAt: now });
    const issueId = await seedIssue(db, projectId, fromId);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await transitionIssueStatus(db as any, issueId, toId);
    expect((await issueFor(issueId)).statusId).toBe(toId);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("illegal issue transition"))).toBe(false);
  });
});
