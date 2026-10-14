import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { guardAgainstSecondBuilder } from "../services/workspace-launch-guard.js";
import { WorkspaceError } from "../services/workspace-internals.js";

/** #1425: /launch over a running builder session is a 409 naming it, unless `replace: true`. */

async function seedWorkspace(db: TestDb): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const issueId = randomUUID();
  const statusId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId, name: "P", repoPath: "/x", repoName: "repo", defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  await db.insert(schema.projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now,
  });
  await db.insert(schema.issues).values({
    id: issueId, issueNumber: 1425, title: "t", priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(schema.workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-1425", workingDir: "/x", baseBranch: "main", isDirect: false,
    status: "active", provider: "claude", createdAt: now, updatedAt: now,
  });
  return workspaceId;
}

async function seedSession(db: TestDb, workspaceId: string, status: string, executor = "claude-code"): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.sessions).values({ id, workspaceId, status, startedAt: now, executor });
  return id;
}

describe("guardAgainstSecondBuilder (#1425)", () => {
  it("passes when no session is running", async () => {
    const { db } = createTestDb();
    const ws = await seedWorkspace(db);
    await seedSession(db, ws, "completed");
    const stop = vi.fn();
    await expect(guardAgainstSecondBuilder(db, ws, {}, stop)).resolves.toBeUndefined();
    expect(stop).not.toHaveBeenCalled();
  });

  it("409s naming the running session", async () => {
    const { db } = createTestDb();
    const ws = await seedWorkspace(db);
    const running = await seedSession(db, ws, "running");
    const stop = vi.fn();
    const err = await guardAgainstSecondBuilder(db, ws, { prompt: "go" }, stop).catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toContain(running);
    expect(err.data).toMatchObject({ reason: "SESSION_ALREADY_RUNNING", sessionId: running });
    expect(stop).not.toHaveBeenCalled();
  });

  it("replace: true stops the running session first", async () => {
    const { db } = createTestDb();
    const ws = await seedWorkspace(db);
    const running = await seedSession(db, ws, "running");
    const stop = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await guardAgainstSecondBuilder(db, ws, { replace: true }, stop);
    expect(stop).toHaveBeenCalledWith(running);
  });

  it("409s over a running review session too, and force stops it (#1475)", async () => {
    const { db } = createTestDb();
    const ws = await seedWorkspace(db);
    const review = await seedSession(db, ws, "running");
    await db.update(schema.sessions).set({ triggerType: "review" }).where(eq(schema.sessions.id, review));
    const stop = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = await guardAgainstSecondBuilder(db, ws, {}, stop).catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect(err.code).toBe("CONFLICT");
    expect(stop).not.toHaveBeenCalled();
    await guardAgainstSecondBuilder(db, ws, { force: true }, stop);
    expect(stop).toHaveBeenCalledWith(review);
  });

  it("ignores a running bisect session", async () => {
    const { db } = createTestDb();
    const ws = await seedWorkspace(db);
    await seedSession(db, ws, "running", "auto-bisect");
    await expect(guardAgainstSecondBuilder(db, ws, {}, vi.fn())).resolves.toBeUndefined();
  });
});
