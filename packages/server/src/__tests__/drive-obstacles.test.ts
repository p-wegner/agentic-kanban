import { describe, expect, it, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import {
  logDriveObstacle,
  listDriveObstacles,
  summarizeDriveObstacles,
  getDriveObstacle,
} from "../repositories/drive-obstacle.repository.js";
import { createDriveObstacleService } from "../services/drive-obstacles.service.js";

async function createProject(db: TestDb, name = "Driver Project") {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name,
    repoPath: `C:/tmp/${projectId}`,
    repoName: name.toLowerCase().replace(/\s+/g, "-"),
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  return projectId;
}

describe("drive-obstacle repository", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb().db;
  });

  it("logs a typed obstacle and reads it back", async () => {
    const projectId = await createProject(db);
    const id = await logDriveObstacle(
      {
        projectId,
        kind: "over_launch",
        severity: "critical",
        issueNumber: 42,
        summary: "Launched 5 workspaces over WIP limit",
        details: { launched: 5, wipLimit: 3 },
      },
      db,
    );
    const row = await getDriveObstacle(id, db);
    expect(row).toMatchObject({
      projectId,
      kind: "over_launch",
      severity: "critical",
      issueNumber: 42,
      summary: "Launched 5 workspaces over WIP limit",
    });
    expect(JSON.parse(row!.details!)).toEqual({ launched: 5, wipLimit: 3 });
  });

  it("defaults severity to warning and details/driveId/issueNumber to null", async () => {
    const projectId = await createProject(db);
    const id = await logDriveObstacle({ projectId, kind: "stall", summary: "No progress for 20m" }, db);
    const row = await getDriveObstacle(id, db);
    expect(row).toMatchObject({ severity: "warning", details: null, driveId: null, issueNumber: null });
  });

  it("lists most-recent-first and filters by kind, severity, and drive", async () => {
    const projectId = await createProject(db);
    const driveId = randomUUID();
    await db.insert(schema.drives).values({
      id: driveId,
      projectId,
      target: "ship the epic",
      status: "active",
      startedAt: new Date().toISOString(),
    });

    await logDriveObstacle({ projectId, kind: "stall", summary: "first", detectedAt: new Date(Date.now() - 3000).toISOString() }, db);
    await logDriveObstacle({ projectId, kind: "verify_gate_failure", severity: "critical", summary: "second", detectedAt: new Date(Date.now() - 2000).toISOString() }, db);
    await logDriveObstacle({ projectId, driveId, kind: "over_launch", summary: "third", detectedAt: new Date(Date.now() - 1000).toISOString() }, db);

    const all = await listDriveObstacles({ projectId }, db);
    expect(all.map((o) => o.summary)).toEqual(["third", "second", "first"]);

    const byKind = await listDriveObstacles({ projectId, kinds: ["stall", "over_launch"] }, db);
    expect(byKind.map((o) => o.summary).sort()).toEqual(["first", "third"]);

    const bySeverity = await listDriveObstacles({ projectId, severities: ["critical"] }, db);
    expect(bySeverity.map((o) => o.summary)).toEqual(["second"]);

    const byDrive = await listDriveObstacles({ projectId, driveId }, db);
    expect(byDrive.map((o) => o.summary)).toEqual(["third"]);
  });

  it("does not leak obstacles across projects", async () => {
    const a = await createProject(db, "A");
    const b = await createProject(db, "B");
    await logDriveObstacle({ projectId: a, kind: "stall", summary: "a-event" }, db);
    await logDriveObstacle({ projectId: b, kind: "stall", summary: "b-event" }, db);
    const forA = await listDriveObstacles({ projectId: a }, db);
    expect(forA.map((o) => o.summary)).toEqual(["a-event"]);
  });

  it("summarizes per-kind counts", async () => {
    const projectId = await createProject(db);
    await logDriveObstacle({ projectId, kind: "stall", summary: "s1" }, db);
    await logDriveObstacle({ projectId, kind: "stall", summary: "s2" }, db);
    await logDriveObstacle({ projectId, kind: "silent_merge_loss", summary: "m1" }, db);

    const summary = await summarizeDriveObstacles({ projectId }, db);
    const map = new Map(summary.map((r) => [r.kind, r.count]));
    expect(map.get("stall")).toBe(2);
    expect(map.get("silent_merge_loss")).toBe(1);
    expect(map.get("over_launch")).toBeUndefined();
  });

  it("persists an obstacle linked to a drive", async () => {
    const projectId = await createProject(db);
    const driveId = randomUUID();
    await db.insert(schema.drives).values({
      id: driveId,
      projectId,
      target: "t",
      status: "active",
      startedAt: new Date().toISOString(),
    });
    const id = await logDriveObstacle({ projectId, driveId, kind: "stall", summary: "linked" }, db);
    const row = await getDriveObstacle(id, db);
    expect(row!.driveId).toBe(driveId);
  });
});

describe("drive-obstacle service", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb().db;
  });

  it("records an obstacle and broadcasts a drive_obstacle event", async () => {
    const projectId = await createProject(db);
    const broadcasts: Array<{ projectId: string; reason: string }> = [];
    const service = createDriveObstacleService(db, (pid, reason) => broadcasts.push({ projectId: pid, reason }));

    const id = await service.record({ projectId, kind: "premature_cascade", summary: "cascaded before verify" });
    expect(id).not.toBeNull();
    expect(broadcasts).toEqual([{ projectId, reason: "drive_obstacle" }]);

    const list = await service.list({ projectId });
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe("premature_cascade");
  });

  it("never throws and returns null on persistence failure (no broadcast)", async () => {
    const broadcasts: string[] = [];
    // A database stub whose insert rejects — telemetry must swallow it, not crash the caller.
    const failingDb = {
      insert: () => ({ values: () => Promise.reject(new Error("db down")) }),
    } as unknown as TestDb;
    const service = createDriveObstacleService(failingDb, () => broadcasts.push("x"));

    const id = await service.record({ projectId: "p", kind: "stall", summary: "boom" });
    expect(id).toBeNull();
    expect(broadcasts).toHaveLength(0);
  });
});
