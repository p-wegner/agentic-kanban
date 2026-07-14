import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { projects, projectStatuses, issues, workspaces, preferences } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import {
  updateWorkspaceServiceState,
  markWorkspaceServiceStateDown,
  getWorkspaceLifecycleStatus,
  getOrCreateServiceStackInstanceId,
} from "../repositories/workspace-service-state.repository.js";

let db: TestDb;

async function seedWorkspace(status: string): Promise<string> {
  const now = new Date(Date.now() - 60_000).toISOString();
  const projectId = randomUUID();
  const issueId = randomUUID();
  const statusId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "P", repoPath: "/tmp/p", repoName: "p", defaultBranch: "main", createdAt: now, updatedAt: now });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now });
  await db.insert(issues).values({ id: issueId, issueNumber: 1, title: "T", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now });
  await db.insert(workspaces).values({ id: workspaceId, issueId, branch: "feature/x", status, createdAt: now, updatedAt: now });
  return workspaceId;
}

async function readServiceState(workspaceId: string): Promise<string | null> {
  const rows = await db.select({ serviceState: workspaces.serviceState }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return rows[0]?.serviceState ?? null;
}

beforeEach(() => {
  ({ db } = createTestDb());
});

describe("updateWorkspaceServiceState", () => {
  const stateJson = JSON.stringify({ composeProjectName: "ak-inst1234-ws-abc123def456", ports: { db: 61000 }, envFilePath: "/x/.kanban/services.env", status: "up", updatedAt: new Date().toISOString() });

  it("persists onto an open workspace and reports 1 row", async () => {
    const id = await seedWorkspace("active");
    await expect(updateWorkspaceServiceState(id, stateJson, db)).resolves.toBe(1);
    expect(await readServiceState(id)).toBe(stateJson);
  });

  it("reports 0 rows for a DELETED workspace (the caller must tear the stack down)", async () => {
    const id = await seedWorkspace("active");
    await db.delete(workspaces).where(eq(workspaces.id, id));
    await expect(updateWorkspaceServiceState(id, stateJson, db)).resolves.toBe(0);
  });

  it("refuses to land on a closed or merged workspace (0 rows, state untouched)", async () => {
    for (const status of ["closed", "merged"]) {
      const id = await seedWorkspace(status);
      await expect(updateWorkspaceServiceState(id, stateJson, db)).resolves.toBe(0);
      expect(await readServiceState(id)).toBeNull();
    }
  });
});

describe("markWorkspaceServiceStateDown", () => {
  it("flips the matching row's stored status to 'down', preserving name and ports", async () => {
    const id = await seedWorkspace("active");
    const upState = { composeProjectName: "ak-inst1234-ws-abc123def456", ports: { db: 61000 }, envFilePath: "/x", status: "up", updatedAt: new Date(Date.now() - 30_000).toISOString() };
    await updateWorkspaceServiceState(id, JSON.stringify(upState), db);

    const nowOverride = new Date().toISOString();
    await markWorkspaceServiceStateDown("ak-inst1234-ws-abc123def456", nowOverride, db);

    const stored = JSON.parse((await readServiceState(id))!) as { status: string; composeProjectName: string; ports: Record<string, number>; updatedAt: string };
    expect(stored.status).toBe("down");
    expect(stored.composeProjectName).toBe("ak-inst1234-ws-abc123def456");
    expect(stored.ports).toEqual({ db: 61000 });
    expect(stored.updatedAt).toBe(nowOverride);
  });

  it("leaves rows with a different compose name (and null states) untouched", async () => {
    const id = await seedWorkspace("active");
    const upState = { composeProjectName: "ak-inst1234-ws-otherotherot", ports: {}, envFilePath: "/x", status: "up", updatedAt: new Date().toISOString() };
    await updateWorkspaceServiceState(id, JSON.stringify(upState), db);
    const noStateId = await seedWorkspace("active");

    await markWorkspaceServiceStateDown("ak-inst1234-ws-abc123def456", undefined, db);

    expect((JSON.parse((await readServiceState(id))!) as { status: string }).status).toBe("up");
    expect(await readServiceState(noStateId)).toBeNull();
  });

  it("is a no-op for an empty compose name", async () => {
    await expect(markWorkspaceServiceStateDown("", undefined, db)).resolves.toBeUndefined();
  });
});

describe("getWorkspaceLifecycleStatus", () => {
  it("returns the status for an existing row and null for a missing one", async () => {
    const id = await seedWorkspace("active");
    await expect(getWorkspaceLifecycleStatus(id, db)).resolves.toEqual({ status: "active" });
    await expect(getWorkspaceLifecycleStatus(randomUUID(), db)).resolves.toBeNull();
  });
});

describe("getOrCreateServiceStackInstanceId", () => {
  it("creates a persisted [a-z0-9]{8} id once and returns the SAME id on every call", async () => {
    const first = await getOrCreateServiceStackInstanceId(db);
    expect(first).toMatch(/^[a-z0-9]{8}$/);
    const second = await getOrCreateServiceStackInstanceId(db);
    expect(second).toBe(first);

    const rows = await db.select({ value: preferences.value }).from(preferences).where(eq(preferences.key, "service_stack_instance_id"));
    expect(rows[0]?.value).toBe(first);
  });

  it("returns an existing valid persisted id instead of generating a new one", async () => {
    await db.insert(preferences).values({ key: "service_stack_instance_id", value: "abcd1234", updatedAt: new Date().toISOString() });
    await expect(getOrCreateServiceStackInstanceId(db)).resolves.toBe("abcd1234");
  });

  it("repairs a garbage persisted value IN PLACE — subsequent calls return the SAME id", async () => {
    await db.insert(preferences).values({ key: "service_stack_instance_id", value: "NOT VALID!!", updatedAt: new Date().toISOString() });
    const id = await getOrCreateServiceStackInstanceId(db);
    expect(id).toMatch(/^[a-z0-9]{8}$/);
    // Stability matters: a flip-flopping id would make provisioned names stop matching
    // the reaper's instance filter.
    await expect(getOrCreateServiceStackInstanceId(db)).resolves.toBe(id);
  });
});
