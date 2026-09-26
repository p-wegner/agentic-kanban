// #1253 (#1246 follow-up) — the moment a workspace became ready-for-merge, stamped/cleared
// alongside every `readyForMerge` write.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issues, projects, projectStatuses, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  clearWorkspaceReadyForMergeAt,
  getWorkspaceReadyForMergeAt,
  getWorkspaceReadyForMergeAtBatch,
  stampWorkspaceReadyForMergeAt,
} from "../repositories/workspace-ready-for-merge.repository.js";

async function seedWorkspace(db: ReturnType<typeof createTestDb>["db"]): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: "/tmp/x", repoName: "x", defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Review", sortOrder: 0, isDefault: true, createdAt: now });
  await db.insert(issues).values({ id: issueId, issueNumber: 1, title: "T", statusId, projectId, createdAt: now, updatedAt: now });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/x", status: "idle", workingDir: "/tmp/x", isDirect: false, createdAt: now, updatedAt: now,
  });
  return workspaceId;
}

describe("workspace-ready-for-merge.repository", () => {
  it("has no row for a workspace that was never stamped", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    expect(await getWorkspaceReadyForMergeAt(workspaceId, db)).toBeUndefined();
  });

  it("stamps, reads back, and clears", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    await stampWorkspaceReadyForMergeAt(workspaceId, "2026-09-26T10:00:00.000Z", db);
    expect(await getWorkspaceReadyForMergeAt(workspaceId, db)).toBe("2026-09-26T10:00:00.000Z");

    await clearWorkspaceReadyForMergeAt(workspaceId, db);
    expect(await getWorkspaceReadyForMergeAt(workspaceId, db)).toBeUndefined();
  });

  it("re-stamping overwrites the previous readySince (a re-arm gets a fresh clock)", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    await stampWorkspaceReadyForMergeAt(workspaceId, "2026-09-26T10:00:00.000Z", db);
    await stampWorkspaceReadyForMergeAt(workspaceId, "2026-09-26T12:00:00.000Z", db);
    expect(await getWorkspaceReadyForMergeAt(workspaceId, db)).toBe("2026-09-26T12:00:00.000Z");
  });

  it("batch reads only the stamped workspaces", async () => {
    const { db } = createTestDb();
    const a = await seedWorkspace(db);
    const b = await seedWorkspace(db);
    await stampWorkspaceReadyForMergeAt(a, "2026-09-26T10:00:00.000Z", db);

    const batch = await getWorkspaceReadyForMergeAtBatch([a, b], db);
    expect(batch.get(a)).toBe("2026-09-26T10:00:00.000Z");
    expect(batch.has(b)).toBe(false);
  });

  it("batch of an empty list reads no rows", async () => {
    const { db } = createTestDb();
    expect(await getWorkspaceReadyForMergeAtBatch([], db)).toEqual(new Map());
  });
});
