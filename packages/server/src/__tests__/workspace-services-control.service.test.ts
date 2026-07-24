import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { projects, projectStatuses, issues, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import { createWorkspaceServicesControlService } from "../services/workspace-services-control.service.js";
import { StackSharedInUseError } from "../services/workspace-services.service.js";
import { WorkspaceError } from "../services/workspace-internals.js";
import type { ServiceStackState } from "@agentic-kanban/shared";

/**
 * Unit tests for the #92 control plane's down()/restart() (#161): the sharer guard
 * used to live ONLY in teardownWorkspaceServices, so these called
 * stopWorkspaceServices/restartWorkspaceServices directly with no guard at all — an
 * adopter's Stop click could remove a live donor's containers out from under its
 * agent. The engine now throws StackSharedInUseError when it refuses; these tests
 * verify the control service turns that into a CONFLICT WorkspaceError instead of
 * either a raw exception or a silent success.
 */
describe("workspace-services-control.service — down/restart guard translation (#161)", () => {
  let db: TestDb;
  let database: Database;
  let projectId: string;
  let workspaceId: string;

  const STORED_STATE: ServiceStackState = {
    composeProjectName: "ak-testinst-ws-abc123def456",
    ports: { db: 61000 },
    envFilePath: "C:/wt/.kanban/services.env",
    status: "up",
    updatedAt: new Date(Date.now() - 60000).toISOString(),
  };

  beforeEach(async () => {
    ({ db } = createTestDb());
    database = db as unknown as Database;
    const now = new Date().toISOString();
    projectId = randomUUID();
    const issueId = randomUUID();
    workspaceId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      name: "P",
      repoPath: "C:\\repos\\p",
      repoName: "p",
      defaultBranch: "main",
      servicesConfig: JSON.stringify({ enabled: true, composeFile: "docker-compose.yml" }),
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
    await db.insert(workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/shared",
      status: "active",
      workingDir: "C:\\wt",
      serviceState: JSON.stringify(STORED_STATE),
      createdAt: now,
      updatedAt: now,
    });
  });

  it("down(): converts the engine's StackSharedInUseError into a CONFLICT WorkspaceError, and never persists a state change", async () => {
    const control = createWorkspaceServicesControlService({
      database,
      engine: {
        stopWorkspaceServices: async () => {
          throw new StackSharedInUseError(STORED_STATE.composeProjectName, ["other-live-workspace-id"]);
        },
        restartWorkspaceServices: async () => STORED_STATE,
        startWorkspaceServices: async () => STORED_STATE,
        provisionWorkspaceServices: async () => STORED_STATE,
        teardownWorkspaceServices: async () => {},
        reapOrphanServiceStacks: async () => ({ reaped: [] }),
        getWorkspaceServiceLogs: async () => ({ ok: true, logs: "" }),
      },
    });

    let caught: unknown;
    try {
      await control.down(workspaceId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkspaceError);
    expect((caught as WorkspaceError).code).toBe("CONFLICT");
    expect((caught as WorkspaceError).message).toMatch(/shared with 1 other live workspace/);

    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(row.serviceState).toContain('"status":"up"'); // unchanged — the refusal must not be persisted as "down"
  });

  it("restart(): converts the engine's StackSharedInUseError into a CONFLICT WorkspaceError", async () => {
    const control = createWorkspaceServicesControlService({
      database,
      engine: {
        stopWorkspaceServices: async () => STORED_STATE,
        restartWorkspaceServices: async () => {
          throw new StackSharedInUseError(STORED_STATE.composeProjectName, ["other-live-workspace-id"]);
        },
        startWorkspaceServices: async () => STORED_STATE,
        provisionWorkspaceServices: async () => STORED_STATE,
        teardownWorkspaceServices: async () => {},
        reapOrphanServiceStacks: async () => ({ reaped: [] }),
        getWorkspaceServiceLogs: async () => ({ ok: true, logs: "" }),
      },
    });

    await expect(control.restart(workspaceId)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("down(): a genuine (unshared) stop persists the returned 'down' state normally", async () => {
    const downedState: ServiceStackState = { ...STORED_STATE, status: "down" };
    const control = createWorkspaceServicesControlService({
      database,
      engine: {
        stopWorkspaceServices: async () => downedState,
        restartWorkspaceServices: async () => STORED_STATE,
        startWorkspaceServices: async () => STORED_STATE,
        provisionWorkspaceServices: async () => STORED_STATE,
        teardownWorkspaceServices: async () => {},
        reapOrphanServiceStacks: async () => ({ reaped: [] }),
        getWorkspaceServiceLogs: async () => ({ ok: true, logs: "" }),
      },
    });

    const result = await control.down(workspaceId);
    expect(result.status).toBe("down");
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(row.serviceState).toContain('"status":"down"');
  });
});
