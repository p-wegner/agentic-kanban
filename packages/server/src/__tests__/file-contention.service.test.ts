import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { getFileContention } from "../services/file-contention.service.js";
import { vi } from "vitest";

// Mock git.service to avoid real git calls
vi.mock("../services/git.service.js", () => ({
  getChangedFileNames: vi.fn(),
}));

import { getChangedFileNames } from "../services/git.service.js";

const mockGetChangedFileNames = vi.mocked(getChangedFileNames);

async function seedProject(db: TestDb) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    name: "Test",
    repoPath: "/tmp/x",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  } as any);
  await db.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "In Progress",
    sortOrder: 1,
    isDefault: false,
    createdAt: now,
  });

  return { projectId, statusId, now };
}

async function seedWorkspace(
  db: TestDb,
  projectId: string,
  statusId: string,
  now: string,
  opts?: { status?: string; branch?: string; workingDir?: string },
) {
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  const branch = opts?.branch ?? `feature/${randomUUID().slice(0, 8)}`;

  await db.insert(schema.issues).values({
    id: issueId,
    issueNumber: Math.floor(Math.random() * 9000) + 1,
    title: "Issue",
    issueType: "bug",
    priority: "medium",
    sortOrder: 0,
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    issueId,
    branch,
    status: opts?.status ?? "active",
    workingDir: opts?.workingDir ?? `/tmp/${branch}`,
    baseBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  return { workspaceId, issueId };
}

describe("getFileContention", () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
    mockGetChangedFileNames.mockReset();
  });

  it("throws when project not found", async () => {
    await expect(getFileContention(randomUUID(), db)).rejects.toThrow("Project not found");
  });

  it("returns empty contested array when there are no active workspaces", async () => {
    const { projectId } = await seedProject(db);

    const result = await getFileContention(projectId, db);
    expect(result.contested).toHaveLength(0);
    expect(result.projectId).toBe(projectId);
  });

  it("returns no contention when workspaces touch different files", async () => {
    const { projectId, statusId, now } = await seedProject(db);
    await seedWorkspace(db, projectId, statusId, now, { workingDir: "/tmp/ws1" });
    await seedWorkspace(db, projectId, statusId, now, { workingDir: "/tmp/ws2" });

    mockGetChangedFileNames
      .mockResolvedValueOnce(["src/foo.ts"])
      .mockResolvedValueOnce(["src/bar.ts"]);

    const result = await getFileContention(projectId, db);
    expect(result.contested).toHaveLength(0);
  });

  it("detects contention when two workspaces touch the same file", async () => {
    const { projectId, statusId, now } = await seedProject(db);
    await seedWorkspace(db, projectId, statusId, now, { workingDir: "/tmp/ws1" });
    await seedWorkspace(db, projectId, statusId, now, { workingDir: "/tmp/ws2" });

    mockGetChangedFileNames
      .mockResolvedValueOnce(["src/shared.ts", "src/foo.ts"])
      .mockResolvedValueOnce(["src/shared.ts", "src/bar.ts"]);

    const result = await getFileContention(projectId, db);
    expect(result.contested).toHaveLength(1);
    expect(result.contested[0].path).toBe("src/shared.ts");
    expect(result.contested[0].workspaces).toHaveLength(2);
  });

  it("includes the default branch from the project", async () => {
    const { projectId } = await seedProject(db);

    const result = await getFileContention(projectId, db);
    expect(result.defaultBranch).toBe("main");
  });

  it("sorts contested files by contention count descending", async () => {
    const { projectId, statusId, now } = await seedProject(db);
    await seedWorkspace(db, projectId, statusId, now, { workingDir: "/tmp/ws1" });
    await seedWorkspace(db, projectId, statusId, now, { workingDir: "/tmp/ws2" });
    await seedWorkspace(db, projectId, statusId, now, { workingDir: "/tmp/ws3" });

    // hot.ts touched by 3 ws, shared.ts touched by 2 ws
    mockGetChangedFileNames
      .mockResolvedValueOnce(["src/hot.ts", "src/shared.ts"])
      .mockResolvedValueOnce(["src/hot.ts", "src/shared.ts"])
      .mockResolvedValueOnce(["src/hot.ts"]);

    const result = await getFileContention(projectId, db);
    expect(result.contested[0].path).toBe("src/hot.ts");
    expect(result.contested[0].workspaces).toHaveLength(3);
    expect(result.contested[1].path).toBe("src/shared.ts");
  });

  it("skips workspaces with no workingDir", async () => {
    const { projectId, statusId, now } = await seedProject(db);
    // workspace without workingDir (null by default in schema)
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 99,
      title: "Issue",
      issueType: "bug",
      priority: "medium",
      sortOrder: 0,
      statusId,
      projectId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/no-dir",
      status: "active",
      workingDir: null,
      baseBranch: "main",
      createdAt: now,
      updatedAt: now,
    });

    const result = await getFileContention(projectId, db);
    expect(result.contested).toHaveLength(0);
    expect(mockGetChangedFileNames).not.toHaveBeenCalled();
  });
});
