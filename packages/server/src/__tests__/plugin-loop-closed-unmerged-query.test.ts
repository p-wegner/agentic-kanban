// @covers pluginLoops.stallQuery.closedUnmerged [query, boundary]
//
// #445 — `listPluginLoopUnmergedWorkspaces` required `workspaces.status != 'closed'`, which was
// right for what it was built for (a builder finished and its branch is WAITING to land) and hid
// an entire second stall shape.
//
// MEASURED on eventhub (`44beaae2-…`), refactor-safety-net `requirement-extraction`: 28 open
// tickets, 9 of them (issues #41, #44, #47, #59, #70, #71, #73, #76, #81) In Review since
// 2026-08-05 with one `closed` workspace holding `mergedAt: null`, `readyForMerge: false`. Nothing
// caught them — no stall, no inbox item, no nudge — and because a loop only replans once its
// round's tickets are all terminal, those nine are a permanent brake. A week with no signal.
//
// These tests are about the WIDTH of the widened query: it must find the nine, and must not start
// reporting ordinary history (a superseded workspace under a Done ticket) as a stall.
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("../db/index.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  const schemaMod = await import("@agentic-kanban/shared/schema");
  const { db } = createTestDb();
  return { db, writeDb: db, rawClient: undefined, rawWriteClient: undefined, schema: schemaMod, withDbRetry: <T>(fn: () => Promise<T>) => fn() };
});

import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import { listPluginLoopUnmergedWorkspaces } from "../repositories/plugins.repository.js";

const KEY_PREFIX = "plugin-loop:refactor-safety-net:requirement-extraction:";

async function seedProject() {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusIds: Record<string, string> = {};
  await db.insert(projects).values({
    id: projectId, name: `p-${projectId.slice(0, 8)}`, repoPath: `/tmp/${projectId}`, repoName: "repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  const names = ["In Progress", "In Review", "Done", "Cancelled"];
  await db.insert(projectStatuses).values(names.map((name, i) => {
    const id = randomUUID();
    statusIds[name] = id;
    return { id, projectId, name, sortOrder: i, isDefault: i === 0, createdAt: now };
  }));
  return { projectId, statusIds };
}

async function seedUnit(
  projectId: string,
  statusId: string,
  unitId: string,
  issueNumber: number,
  ws: { status: string; mergedAt?: string | null; readyForMerge?: boolean },
) {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(issues).values({
    id: issueId, issueNumber, title: `unit ${unitId}`, priority: "medium", sortOrder: 0,
    statusId, projectId, externalKey: `${KEY_PREFIX}${unitId}`, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: `feature/ak-${issueNumber}-${unitId}`, workingDir: null,
    baseBranch: "main", isDirect: false, status: ws.status, mergedAt: ws.mergedAt ?? null,
    readyForMerge: ws.readyForMerge ?? false, provider: "claude", createdAt: now, updatedAt: now,
  });
  return { issueId, workspaceId };
}

describe("listPluginLoopUnmergedWorkspaces — closed-and-never-merged (#445)", () => {
  it("returns eventhub's shape: closed workspace, mergedAt null, ticket still In Review", async () => {
    const { projectId, statusIds } = await seedProject();
    const { workspaceId } = await seedUnit(projectId, statusIds["In Review"], "req-41", 41, { status: "closed" });
    const rows = await listPluginLoopUnmergedWorkspaces(projectId, KEY_PREFIX, db);
    expect(rows.map((r) => r.workspaceId)).toEqual([workspaceId]);
    expect(rows[0].workspaceStatus).toBe("closed");
  });

  it("also catches it while the ticket never left In Progress", async () => {
    // The brake is the same: the ticket is non-terminal, so the round never completes.
    const { projectId, statusIds } = await seedProject();
    await seedUnit(projectId, statusIds["In Progress"], "req-44", 44, { status: "closed" });
    expect((await listPluginLoopUnmergedWorkspaces(projectId, KEY_PREFIX, db)).length).toBe(1);
  });

  it("does NOT report a closed unmerged workspace under a Done ticket", async () => {
    // Ordinary history — a superseded workspace on a unit that finished some other way. Reporting
    // it would bury the nine real ones under noise from every completed round.
    const { projectId, statusIds } = await seedProject();
    await seedUnit(projectId, statusIds["Done"], "req-9", 9, { status: "closed" });
    expect(await listPluginLoopUnmergedWorkspaces(projectId, KEY_PREFIX, db)).toEqual([]);
  });

  it("does NOT report a closed unmerged workspace under a Cancelled ticket", async () => {
    const { projectId, statusIds } = await seedProject();
    await seedUnit(projectId, statusIds["Cancelled"], "req-10", 10, { status: "closed" });
    expect(await listPluginLoopUnmergedWorkspaces(projectId, KEY_PREFIX, db)).toEqual([]);
  });

  it("does NOT report a closed workspace that actually merged", async () => {
    const { projectId, statusIds } = await seedProject();
    await seedUnit(projectId, statusIds["In Review"], "req-11", 11, {
      status: "closed", mergedAt: new Date().toISOString(),
    });
    expect(await listPluginLoopUnmergedWorkspaces(projectId, KEY_PREFIX, db)).toEqual([]);
  });

  it("keeps the pre-existing arms intact — an In Progress ticket with an OPEN idle workspace is still not a stall", async () => {
    // The widening must not turn every running unit into a stall; only `ready_for_merge` (or a
    // finished issue status) qualifies on the non-closed side, exactly as before.
    const { projectId, statusIds } = await seedProject();
    await seedUnit(projectId, statusIds["In Progress"], "req-12", 12, { status: "running" });
    expect(await listPluginLoopUnmergedWorkspaces(projectId, KEY_PREFIX, db)).toEqual([]);
  });

  it("still returns #299's open finished-unmerged row", async () => {
    const { projectId, statusIds } = await seedProject();
    const { workspaceId } = await seedUnit(projectId, statusIds["In Review"], "req-13", 13, { status: "idle" });
    expect((await listPluginLoopUnmergedWorkspaces(projectId, KEY_PREFIX, db)).map((r) => r.workspaceId))
      .toEqual([workspaceId]);
  });

  it("still returns #363's parked row", async () => {
    const { projectId, statusIds } = await seedProject();
    const { workspaceId } = await seedUnit(projectId, statusIds["In Progress"], "req-14", 14, {
      status: "ready_for_merge",
    });
    expect((await listPluginLoopUnmergedWorkspaces(projectId, KEY_PREFIX, db)).map((r) => r.workspaceId))
      .toEqual([workspaceId]);
  });
});
