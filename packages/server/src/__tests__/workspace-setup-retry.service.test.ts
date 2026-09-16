/**
 * #1166 — a failed `workspace_setup_run` has no retry door when `setup_blocking = 0`.
 *
 * `POST /:id/setup` only recreates a MISSING worktree, and no-ops once `workingDir` is set —
 * exactly the state a failed non-blocking install leaves behind. This service is the recovery
 * door: it re-runs the project's setup script in the workspace's EXISTING worktree and restamps
 * the verdict, so the pre-merge gate's `describeFailedSetupRun` check
 * (`pre-merge-gate-setup-failure.ts`) can pass again after a successful retry.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaceSetupRun, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";

const runSetupScriptMock = vi.fn();
vi.mock("../services/setup-script.js", () => ({
  runSetupScript: (...args: unknown[]) => runSetupScriptMock(...args),
}));

const { createWorkspaceSetupRetryService } = await import("../services/workspace-setup-retry.service.js");
const { WorkspaceError } = await import("../services/workspace-internals.js");

const T0 = "2026-09-16T00:00:00.000Z";

type Db = ReturnType<typeof createTestDb>["db"];

async function seedWorkspace(
  db: Db,
  opts: { setupScript?: string | null; workingDir?: string | null } = {},
): Promise<string> {
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    // `=== undefined`, not `??`: an explicit `null` is the "project has no setup script"
    // case this file tests, and `??` collapses it back to the default — so the refusal case
    // silently seeded a project that DID have one. Same form as `workingDir` below.
    defaultBranch: "master",
    setupScript: opts.setupScript === undefined ? "pnpm install -r" : opts.setupScript,
    setupBlocking: false, createdAt: T0, updatedAt: T0,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 1, isDefault: false, createdAt: T0,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 1, title: "Issue 1", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: T0, updatedAt: T0,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-1",
    workingDir: opts.workingDir === undefined ? "/repo/.worktrees/ws" : opts.workingDir,
    baseBranch: "master", status: "ready", provider: "claude", createdAt: T0, updatedAt: T0,
  });
  await db.insert(workspaceSetupRun).values({
    workspaceId,
    command: "pnpm install -r",
    state: "failed",
    startedAt: T0,
    endedAt: T0,
    exitCode: 1,
    durationMs: 500,
    stdoutTail: null,
    stderrTail: "network error",
  });
  return workspaceId;
}

beforeEach(() => vi.clearAllMocks());

describe("createWorkspaceSetupRetryService (#1166)", () => {
  it("re-runs the setup script and restamps the run as succeeded on success", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    runSetupScriptMock.mockResolvedValue({ exitCode: 0, stdout: "installed", stderr: "" });

    const service = createWorkspaceSetupRetryService({ database: db });
    const result = await service.retrySetup(workspaceId);

    expect(runSetupScriptMock).toHaveBeenCalledWith("/repo/.worktrees/ws", "pnpm install -r");
    expect(result.latestSetup.state).toBe("success");
    expect(result.latestSetup.exitCode).toBe(0);

    const [row] = await db.select().from(workspaceSetupRun).where(eq(workspaceSetupRun.workspaceId, workspaceId));
    expect(row?.state).toBe("success");
    expect(row?.exitCode).toBe(0);
  });

  it("restamps as failed (with a fresh timestamp) when the retry fails again", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    runSetupScriptMock.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "still broken" });

    const service = createWorkspaceSetupRetryService({ database: db });
    const result = await service.retrySetup(workspaceId);

    expect(result.latestSetup.state).toBe("failed");
    const [row] = await db.select().from(workspaceSetupRun).where(eq(workspaceSetupRun.workspaceId, workspaceId));
    expect(row?.state).toBe("failed");
    expect(row?.stderrTail).toContain("still broken");
    // Restamped, not the original 5-day-old verdict.
    expect(row?.endedAt).not.toBe(T0);
  });

  it("refuses a workspace with no worktree yet", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db, { workingDir: null });

    const service = createWorkspaceSetupRetryService({ database: db });
    await expect(service.retrySetup(workspaceId)).rejects.toThrow(WorkspaceError);
    expect(runSetupScriptMock).not.toHaveBeenCalled();
  });

  it("refuses a project with no setup script configured", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db, { setupScript: null });

    const service = createWorkspaceSetupRetryService({ database: db });
    await expect(service.retrySetup(workspaceId)).rejects.toThrow(WorkspaceError);
    expect(runSetupScriptMock).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND for an unknown workspace", async () => {
    const { db } = createTestDb();
    const service = createWorkspaceSetupRetryService({ database: db });
    await expect(service.retrySetup(randomUUID())).rejects.toThrow(WorkspaceError);
  });
});
