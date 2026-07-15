import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

vi.mock("../services/git.service.js", () => ({
  listBranches: vi.fn(async () => []),
  listWorktrees: vi.fn(async () => []),
  getDiffShortstat: vi.fn(async () => ({ filesChanged: 0, insertions: 0, deletions: 0 })),
  removeWorktree: vi.fn(async () => {}),
}));

import { removeWorktree } from "../services/git.service.js";
import { createProjectService } from "../services/project.service.js";
import { workspaceServicesService } from "../services/workspace-services.service.js";

let db: TestDb;

beforeAll(async () => {
  db = createTestDb().db;
});

async function seedProjectWithIssueAndWorkspace(options: {
  isDirect?: boolean;
  serviceState?: string | null;
  workingDir?: string | null;
}) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "Test Project",
    repoPath: "/tmp/test-repo",
    repoName: "test-repo",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  const statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "In Progress",
    sortOrder: 0,
    isDefault: true,
    createdAt: now,
  });

  const issueId = randomUUID();
  await db.insert(schema.issues).values({
    id: issueId,
    issueNumber: 1,
    title: "Fork child worktree removal",
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });

  const workspaceId = randomUUID();
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-1-fork-child",
    status: "active",
    workingDir: options.workingDir ?? "/tmp/test-repo/.worktrees/feature-1",
    isDirect: options.isDirect ?? false,
    serviceState: options.serviceState ?? null,
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId, workspaceId };
}

describe("removeWorktreeById tears down the service stack (finding 26)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls teardownWorkspaceServices with the stored compose project name and releaser id before removing the worktree", async () => {
    const stack = "ak-testinst-ws-forkchild001";
    const { projectId, workspaceId } = await seedProjectWithIssueAndWorkspace({
      serviceState: JSON.stringify({
        composeProjectName: stack,
        ports: { db: 61000 },
        envFilePath: "/tmp/test-repo/.worktrees/feature-1/.kanban/services.env",
        status: "up",
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    });

    const teardownSpy = vi
      .spyOn(workspaceServicesService, "teardownWorkspaceServices")
      .mockResolvedValue(undefined);

    const service = createProjectService({ database: db });
    await service.removeWorktreeById(projectId, { workspaceId });

    expect(teardownSpy).toHaveBeenCalledOnce();
    expect(teardownSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        composeProjectName: stack,
        composeWorktreePath: "/tmp/test-repo/.worktrees/feature-1",
        releasedByWorkspaceId: workspaceId,
      }),
    );
    expect(removeWorktree).toHaveBeenCalledOnce();
  });

  it("does not attempt teardown when the workspace has no stored service state", async () => {
    const { projectId, workspaceId } = await seedProjectWithIssueAndWorkspace({ serviceState: null });

    const teardownSpy = vi
      .spyOn(workspaceServicesService, "teardownWorkspaceServices")
      .mockResolvedValue(undefined);

    const service = createProjectService({ database: db });
    await service.removeWorktreeById(projectId, { workspaceId });

    expect(teardownSpy).not.toHaveBeenCalled();
    expect(removeWorktree).toHaveBeenCalledOnce();
  });

  it("does not attempt teardown for a direct workspace (no worktree/compose stack)", async () => {
    const { projectId, workspaceId } = await seedProjectWithIssueAndWorkspace({
      isDirect: true,
      serviceState: JSON.stringify({
        composeProjectName: "ak-testinst-ws-direct0001",
        ports: {},
        envFilePath: "/tmp/test-repo/.kanban/services.env",
        status: "up",
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    });

    const teardownSpy = vi
      .spyOn(workspaceServicesService, "teardownWorkspaceServices")
      .mockResolvedValue(undefined);

    const service = createProjectService({ database: db });
    await service.removeWorktreeById(projectId, { workspaceId });

    expect(teardownSpy).not.toHaveBeenCalled();
  });
});
