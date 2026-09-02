/**
 * #1004 — a ticket sitting in a driver-owned column (In Progress) on a project whose
 * RESOLVED Start Mode is `manual` is visibly marked as having no driver. "In Progress" is the
 * column whose whole meaning is "a driver owns this"; on a `manual` project a review's
 * request-changes move parks the ticket with nobody on it, and before this the board showed
 * nothing that distinguished it from a `monitor` project where the next cycle relaunches.
 *
 * The decision MUST come from `resolveStartPolicy` (decision 008), not from a second read of
 * the raw `start_mode_<id>` pref — the third case below pins that: a project with NO explicit
 * start_mode but a legacy `board_autodrive_<id>=true` resolves to `monitor`, and must not be
 * accused of parking its tickets.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createProjectService } from "../services/project.service.js";
import { setPreference } from "../repositories/preferences.repository.js";
import { startModePrefKey } from "../services/start-policy.service.js";

let db: TestDb;

interface Fixture { projectId: string; inProgressStatusId: string; todoStatusId: string }

async function seedProject(name: string): Promise<Fixture> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name,
    repoPath: `/tmp/${projectId}`,
    repoName: name,
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  const todoStatusId = randomUUID();
  const inProgressStatusId = randomUUID();
  await db.insert(schema.projectStatuses).values([
    { id: todoStatusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now },
    { id: inProgressStatusId, projectId, name: "In Progress", sortOrder: 1, isDefault: false, createdAt: now },
  ]);
  return { projectId, inProgressStatusId, todoStatusId };
}

let issueSeq = 500;
async function seedIssue(f: Fixture, statusId: string, workspaceStatus?: "idle" | "active"): Promise<string> {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  await db.insert(schema.issues).values({
    id: issueId,
    issueNumber: issueSeq++,
    title: `issue ${issueSeq}`,
    statusId,
    projectId: f.projectId,
    createdAt: now,
    updatedAt: now,
    statusChangedAt: now,
  });
  if (workspaceStatus) {
    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      issueId,
      branch: `feature/ak-${issueSeq}`,
      status: workspaceStatus,
      readyForMerge: false,
      createdAt: now,
      updatedAt: now,
    });
  }
  return issueId;
}

async function boardIssue(projectId: string, issueId: string) {
  const service = createProjectService({ database: db });
  const board = await service.getBoard(projectId, new Date().toISOString());
  return board.flatMap((c) => c.issues).find((i) => i.id === issueId);
}

beforeAll(() => {
  db = createTestDb().db;
});

describe("awaitingManualStart on the board (#1004)", () => {
  it("marks an idle In-Progress ticket on an explicit `manual` project, and nothing else", async () => {
    const f = await seedProject("manual-project");
    await setPreference(startModePrefKey(f.projectId), "manual", db);

    const parked = await seedIssue(f, f.inProgressStatusId, "idle");
    const noWorkspace = await seedIssue(f, f.inProgressStatusId);
    const driven = await seedIssue(f, f.inProgressStatusId, "active");
    const todo = await seedIssue(f, f.todoStatusId);

    expect((await boardIssue(f.projectId, parked))?.awaitingManualStart).toBe(true);
    expect((await boardIssue(f.projectId, noWorkspace))?.awaitingManualStart).toBe(true);
    // An active builder IS the driver — the column is telling the truth.
    expect((await boardIssue(f.projectId, driven))?.awaitingManualStart).toBeUndefined();
    // Todo is not a driver-owned column.
    expect((await boardIssue(f.projectId, todo))?.awaitingManualStart).toBeUndefined();
  });

  it("never marks the same column on an explicit `monitor` project — the next cycle relaunches", async () => {
    const f = await seedProject("monitor-project");
    await setPreference(startModePrefKey(f.projectId), "monitor", db);

    const idle = await seedIssue(f, f.inProgressStatusId, "idle");
    expect((await boardIssue(f.projectId, idle))?.awaitingManualStart).toBeUndefined();
  });

  it("never marks it on a `conductor` project — the external loop owns starts", async () => {
    const f = await seedProject("conductor-project");
    await setPreference(startModePrefKey(f.projectId), "conductor", db);

    const idle = await seedIssue(f, f.inProgressStatusId, "idle");
    expect((await boardIssue(f.projectId, idle))?.awaitingManualStart).toBeUndefined();
  });

  it("reads the RESOLVED policy: a legacy `board_autodrive` flag with no start_mode derives `monitor`, so no mark", async () => {
    const f = await seedProject("legacy-autodrive-project");
    // No `start_mode_<id>` at all — resolveStartPolicy derives `monitor` from the legacy flag.
    // A raw pref read would see "no start_mode" and could default to accusing the project.
    await setPreference(`board_autodrive_${f.projectId}`, "true", db);

    const idle = await seedIssue(f, f.inProgressStatusId, "idle");
    expect((await boardIssue(f.projectId, idle))?.awaitingManualStart).toBeUndefined();
  });

  it("a project with no prefs at all resolves to `manual` and IS marked", async () => {
    const f = await seedProject("unconfigured-project");

    const idle = await seedIssue(f, f.inProgressStatusId, "idle");
    expect((await boardIssue(f.projectId, idle))?.awaitingManualStart).toBe(true);
  });
});
