/**
 * #801 — the drive completion contract, encoded in the autodrive engine.
 *
 * Verifies reconcileDriveCompletion enforces the `drive-new-project` contract:
 *  - While any child of a drive's meta is still open, the engine refuses to leave the meta
 *    in In Review / Done — it pulls it back to In Progress.
 *  - When all children are terminal (N/N Done), the engine drives the meta to Done and
 *    marks the drive completed.
 *  - A drive with no meta, or a meta with no children, is a no-op.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  drives,
  issueDependencies,
  issues,
  projectStatuses,
  projects,
} from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { reconcileDriveCompletion } from "../startup/drive-completion-reconciler.js";

type Db = ReturnType<typeof createTestDb>["db"];

const now = "2026-06-14T00:00:00.000Z";

interface Scenario {
  projectId: string;
  statusIds: Record<string, string>;
  metaId: string;
  childIds: string[];
  driveId: string;
}

async function seed(
  db: Db,
  opts: {
    metaStatus: string;
    childStatuses: string[];
    /** Omit to create a drive with no meta. */
    linkMeta?: boolean;
    /** Omit to skip wiring child_of edges. */
    linkChildren?: boolean;
    driveStatus?: "active" | "completed" | "abandoned";
  },
): Promise<Scenario> {
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "drive",
    repoPath: "/repo",
    repoName: "repo",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });

  const statusNames = ["Backlog", "Todo", "In Progress", "In Review", "AI Reviewed", "Done", "Cancelled"];
  const statusIds: Record<string, string> = {};
  await db.insert(projectStatuses).values(
    statusNames.map((name, i) => {
      const id = randomUUID();
      statusIds[name] = id;
      return { id, projectId, name, sortOrder: i - 1, isDefault: name === "Backlog", createdAt: now };
    }),
  );

  const metaId = randomUUID();
  await db.insert(issues).values({
    id: metaId,
    issueNumber: 1,
    title: "[EPIC] meta",
    priority: "medium",
    sortOrder: 0,
    statusId: statusIds[opts.metaStatus],
    projectId,
    createdAt: now,
    updatedAt: now,
  });

  const childIds: string[] = [];
  for (let i = 0; i < opts.childStatuses.length; i++) {
    const childId = randomUUID();
    childIds.push(childId);
    await db.insert(issues).values({
      id: childId,
      issueNumber: 2 + i,
      title: `child ${i}`,
      priority: "medium",
      sortOrder: i,
      statusId: statusIds[opts.childStatuses[i]],
      projectId,
      createdAt: now,
      updatedAt: now,
    });
    if (opts.linkChildren !== false) {
      await db.insert(issueDependencies).values({
        id: randomUUID(),
        issueId: childId,
        dependsOnId: metaId,
        type: "child_of",
        createdAt: now,
      });
    }
  }

  const driveId = randomUUID();
  await db.insert(drives).values({
    id: driveId,
    projectId,
    metaIssueId: opts.linkMeta === false ? null : metaId,
    target: "build the thing",
    completionContract: "N/N children Done",
    status: opts.driveStatus ?? "active",
    startedAt: now,
    finishedAt: null,
  });

  return { projectId, statusIds, metaId, childIds, driveId };
}

async function metaStatusName(db: Db, s: Scenario): Promise<string> {
  const rows = await db
    .select({ name: projectStatuses.name })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(issues.id, s.metaId))
    .limit(1);
  return rows[0].name;
}

async function driveStatus(db: Db, s: Scenario): Promise<string> {
  const rows = await db.select({ status: drives.status }).from(drives).where(eq(drives.id, s.driveId)).limit(1);
  return rows[0].status;
}

describe("reconcileDriveCompletion — drive completion contract (#801)", () => {
  let db: Db;
  beforeEach(() => {
    db = createTestDb().db;
  });

  it("pulls the meta back to In Progress when it's in Review but children remain open", async () => {
    const s = await seed(db, { metaStatus: "In Review", childStatuses: ["Done", "In Progress"] });
    const changed = await reconcileDriveCompletion(db, { now });
    expect(changed).toBe(1);
    expect(await metaStatusName(db, s)).toBe("In Progress");
    // Drive stays active — the epic is not finished.
    expect(await driveStatus(db, s)).toBe("active");
  });

  it("pulls the meta back to In Progress when it's Done but children remain open", async () => {
    const s = await seed(db, { metaStatus: "Done", childStatuses: ["Done", "Todo"] });
    const changed = await reconcileDriveCompletion(db, { now });
    expect(changed).toBe(1);
    expect(await metaStatusName(db, s)).toBe("In Progress");
    expect(await driveStatus(db, s)).toBe("active");
  });

  it("drives the meta to Done (not Review) and completes the drive at N/N children done", async () => {
    const s = await seed(db, { metaStatus: "In Progress", childStatuses: ["Done", "Done", "Cancelled"] });
    const changed = await reconcileDriveCompletion(db, { now });
    expect(changed).toBeGreaterThanOrEqual(1);
    expect(await metaStatusName(db, s)).toBe("Done");
    expect(await driveStatus(db, s)).toBe("completed");
    const finished = await db.select({ finishedAt: drives.finishedAt }).from(drives).where(eq(drives.id, s.driveId)).limit(1);
    expect(finished[0].finishedAt).toBe(now);
  });

  it("completes the drive when the meta is already Done at N/N (no status move needed)", async () => {
    const s = await seed(db, { metaStatus: "Done", childStatuses: ["Done", "Done"] });
    const changed = await reconcileDriveCompletion(db, { now });
    expect(changed).toBeGreaterThanOrEqual(1);
    expect(await metaStatusName(db, s)).toBe("Done");
    expect(await driveStatus(db, s)).toBe("completed");
  });

  it("does not touch the meta while it is In Progress and children remain open", async () => {
    const s = await seed(db, { metaStatus: "In Progress", childStatuses: ["Done", "In Progress"] });
    const changed = await reconcileDriveCompletion(db, { now });
    expect(changed).toBe(0);
    expect(await metaStatusName(db, s)).toBe("In Progress");
    expect(await driveStatus(db, s)).toBe("active");
  });

  it("is a no-op for a drive with no meta issue", async () => {
    const s = await seed(db, { metaStatus: "In Review", childStatuses: ["In Progress"], linkMeta: false });
    const changed = await reconcileDriveCompletion(db, { now });
    expect(changed).toBe(0);
    // Meta status untouched (it is orphaned from the drive).
    expect(await metaStatusName(db, s)).toBe("In Review");
  });

  it("is a no-op for a meta with no children linked", async () => {
    const s = await seed(db, { metaStatus: "In Review", childStatuses: [], linkChildren: false });
    const changed = await reconcileDriveCompletion(db, { now });
    expect(changed).toBe(0);
    expect(await metaStatusName(db, s)).toBe("In Review");
    expect(await driveStatus(db, s)).toBe("active");
  });

  it("ignores already-completed / abandoned drives", async () => {
    const s = await seed(db, {
      metaStatus: "In Review",
      childStatuses: ["In Progress"],
      driveStatus: "abandoned",
    });
    const changed = await reconcileDriveCompletion(db, { now });
    expect(changed).toBe(0);
    expect(await metaStatusName(db, s)).toBe("In Review");
  });
});
