import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, projectStatuses, issues, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import {
  findLiveWorkspacesSharingWorkingDir,
  findLiveWorkspacesReferencingComposeProject,
} from "../repositories/workspace-service-state.repository.js";

/**
 * Repository queries backing the shared-worktree service-stack semantics (finding 12):
 * co-resident detection at provision time and the teardown last-reference guard.
 */

const SHARED_DIR = "C:\\repos\\.worktrees\\feature-shared";
const STACK = "ak-testinst-ws-abc123def456";

function upStateJson(composeProjectName: string, status: "up" | "error" | "down" = "up"): string {
  return JSON.stringify({
    composeProjectName,
    ports: { db: 61000 },
    envFilePath: `${SHARED_DIR}\\.kanban\\services.env`,
    status,
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
  });
}

describe("workspace-service-state repository — shared-worktree queries", () => {
  let db: TestDb;
  let database: Database;
  let issueId: string;

  beforeEach(async () => {
    ({ db } = createTestDb());
    database = db as unknown as Database;
    const now = new Date(Date.now() - 120_000).toISOString();
    const projectId = randomUUID();
    issueId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      name: "P",
      repoPath: "C:\\repos\\p",
      repoName: "p",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
    const statusId = randomUUID();
    await db.insert(projectStatuses).values({
      id: statusId,
      projectId,
      name: "Todo",
      sortOrder: 0,
      isDefault: true,
      createdAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      issueNumber: 1,
      title: "T",
      sortOrder: 0,
      statusId,
      projectId,
      createdAt: now,
      updatedAt: now,
    });
  });

  async function insertWs(overrides: Partial<typeof workspaces.$inferInsert> = {}): Promise<string> {
    const id = (overrides.id as string | undefined) ?? randomUUID();
    await db.insert(workspaces).values({
      id,
      issueId,
      branch: "feature/shared",
      status: "active",
      workingDir: SHARED_DIR,
      createdAt: new Date(Date.now() - 90_000).toISOString(),
      updatedAt: new Date(Date.now() - 90_000).toISOString(),
      ...overrides,
    });
    return id;
  }

  describe("findLiveWorkspacesSharingWorkingDir", () => {
    it("returns OTHER live workspaces on the same workingDir, excluding self and terminal rows", async () => {
      const me = await insertWs();
      const liveSharer = await insertWs({ serviceState: upStateJson(STACK) });
      await insertWs({ status: "closed" });
      await insertWs({ status: "merged" });
      await insertWs({ workingDir: "C:\\repos\\.worktrees\\other" });

      const sharers = await findLiveWorkspacesSharingWorkingDir(SHARED_DIR, me, database);
      expect(sharers.map((s) => s.id)).toEqual([liveSharer]);
      expect(sharers[0].serviceState).toContain(STACK);
      expect(sharers[0].createdAt).toBeTruthy();
    });

    it("returns [] for an empty workingDir", async () => {
      await insertWs();
      expect(await findLiveWorkspacesSharingWorkingDir("", "whatever", database)).toEqual([]);
    });
  });

  describe("findLiveWorkspacesReferencingComposeProject", () => {
    it("returns only LIVE rows whose stored state claims the name with status 'up'", async () => {
      const liveUp = await insertWs({ serviceState: upStateJson(STACK) });
      await insertWs({ serviceState: upStateJson(STACK), status: "closed" });
      await insertWs({ serviceState: upStateJson(STACK), status: "merged" });
      await insertWs({ serviceState: upStateJson(STACK, "down") });
      await insertWs({ serviceState: upStateJson(STACK, "error") });
      await insertWs({ serviceState: upStateJson("ak-testinst-ws-otherstack1") });
      await insertWs({ serviceState: null });

      const refs = await findLiveWorkspacesReferencingComposeProject(STACK, database);
      expect(refs.map((r) => r.id)).toEqual([liveUp]);
    });

    it("returns [] for an empty compose project name", async () => {
      await insertWs({ serviceState: upStateJson(STACK) });
      expect(await findLiveWorkspacesReferencingComposeProject("", database)).toEqual([]);
    });
  });

  it("engine + repository integration: the down runs only for the LAST live sharer", async () => {
    // Two live sharers reference the same stack; releasing one skips the down, closing
    // it and releasing the other runs the down — the full last-reference lifecycle
    // against the real query (not a fake).
    const { createWorkspaceServicesService } = await import("../services/workspace-services.service.js");
    const downs: string[] = [];
    const svc = createWorkspaceServicesService({
      runner: {
        up: async () => ({ ok: true, stderr: "" }),
        down: async ({ projectName }) => {
          downs.push(projectName);
          return { ok: true, stderr: "" };
        },
        list: async () => [],
      },
      getInstanceId: async () => "testinst",
      markServiceStateDown: async () => {},
      findLiveStackReferences: (name) => findLiveWorkspacesReferencingComposeProject(name, database),
    });

    const a = await insertWs({ serviceState: upStateJson(STACK) });
    const b = await insertWs({ serviceState: upStateJson(STACK) });

    // A releases first — B still references the stack → no down.
    await svc.teardownWorkspaceServices({ composeProjectName: STACK, composeWorktreePath: ".", releasedByWorkspaceId: a });
    expect(downs).toEqual([]);

    // A goes terminal (mirrors close/merge finalization), then B releases → down.
    const { eq } = await import("drizzle-orm");
    await db.update(workspaces).set({ status: "closed" }).where(eq(workspaces.id, a));
    await svc.teardownWorkspaceServices({ composeProjectName: STACK, composeWorktreePath: ".", releasedByWorkspaceId: b });
    expect(downs).toEqual([STACK]);
  });
});
