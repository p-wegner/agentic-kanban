import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, preferences, projects, projectStatuses, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  isProjectFinished,
  projectCompletionMarkerKey,
  reconcileProjectCompletion,
} from "../startup/project-completion-reconciler.js";

function makeBoardEvents() {
  const broadcasts: Array<{ projectId: string; reason: string }> = [];
  return {
    broadcasts,
    boardEvents: {
      broadcast: (projectId: string, reason: string) => broadcasts.push({ projectId, reason }),
    } as any,
  };
}

async function seedProject(db: ReturnType<typeof createTestDb>["db"], name: string) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name, repoPath: `/tmp/${name}`, repoName: name, createdAt: now, updatedAt: now,
  });
  const statuses: Record<string, string> = {};
  let sort = 0;
  for (const statusName of ["Backlog", "In Progress", "In Review", "Done", "Cancelled"]) {
    const id = randomUUID();
    statuses[statusName] = id;
    await db.insert(projectStatuses).values({
      id, projectId, name: statusName, sortOrder: sort++, isDefault: statusName === "Backlog", createdAt: now,
    });
  }
  return { projectId, statuses };
}

async function seedIssue(
  db: ReturnType<typeof createTestDb>["db"],
  projectId: string,
  statusId: string,
  issueNumber: number,
) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(issues).values({
    id, projectId, statusId, title: `Issue ${issueNumber}`, issueNumber, createdAt: now, updatedAt: now,
  });
  return id;
}

describe("isProjectFinished", () => {
  it("is true when all issues terminal and no open workspaces", () => {
    expect(isProjectFinished({ totalIssues: 3, openIssues: 0, openWorkspaces: 0 })).toBe(true);
  });
  it("is false with open issues", () => {
    expect(isProjectFinished({ totalIssues: 3, openIssues: 1, openWorkspaces: 0 })).toBe(false);
  });
  it("is false with an open workspace still mid-flight", () => {
    expect(isProjectFinished({ totalIssues: 3, openIssues: 0, openWorkspaces: 1 })).toBe(false);
  });
  it("is false for an empty project (never had a backlog)", () => {
    expect(isProjectFinished({ totalIssues: 0, openIssues: 0, openWorkspaces: 0 })).toBe(false);
  });
});

describe("reconcileProjectCompletion", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    db = createTestDb().db;
  });

  it("broadcasts project_completed once when the backlog is fully implemented", async () => {
    const { projectId, statuses } = await seedProject(db, "finished-proj");
    await seedIssue(db, projectId, statuses.Done, 1);
    await seedIssue(db, projectId, statuses.Cancelled, 2);

    const { boardEvents, broadcasts } = makeBoardEvents();
    const changed = await reconcileProjectCompletion(db, { boardEvents });

    expect(changed).toBe(1);
    expect(broadcasts).toEqual([{ projectId, reason: "project_completed" }]);

    // Marker persisted.
    const [marker] = await db.select().from(preferences).where(eq(preferences.key, projectCompletionMarkerKey(projectId)));
    expect(marker?.value).toBe("true");

    // Second tick: already announced → no re-broadcast.
    const { boardEvents: be2, broadcasts: b2 } = makeBoardEvents();
    const changed2 = await reconcileProjectCompletion(db, { boardEvents: be2 });
    expect(changed2).toBe(0);
    expect(b2).toEqual([]);
  });

  it("does not announce a project with open issues", async () => {
    const { projectId, statuses } = await seedProject(db, "open-proj");
    await seedIssue(db, projectId, statuses.Done, 1);
    await seedIssue(db, projectId, statuses["In Progress"], 2);

    const { boardEvents, broadcasts } = makeBoardEvents();
    const changed = await reconcileProjectCompletion(db, { boardEvents });
    expect(changed).toBe(0);
    expect(broadcasts).toEqual([]);
  });

  it("does not announce an empty project", async () => {
    const { projectId } = await seedProject(db, "empty-proj");
    void projectId;
    const { boardEvents, broadcasts } = makeBoardEvents();
    const changed = await reconcileProjectCompletion(db, { boardEvents });
    expect(changed).toBe(0);
    expect(broadcasts).toEqual([]);
  });

  it("does not announce while a workspace is still open", async () => {
    const { projectId, statuses } = await seedProject(db, "ws-open-proj");
    const issueId = await seedIssue(db, projectId, statuses.Done, 1);
    const now = new Date().toISOString();
    await db.insert(workspaces).values({
      id: randomUUID(), issueId, branch: "feature/ak-1", status: "reviewing",
      baseBranch: "main", isDirect: false, createdAt: now, updatedAt: now,
    });

    const { boardEvents, broadcasts } = makeBoardEvents();
    const changed = await reconcileProjectCompletion(db, { boardEvents });
    expect(changed).toBe(0);
    expect(broadcasts).toEqual([]);
  });

  it("resets the marker and re-announces when new work is added then completed", async () => {
    const { projectId, statuses } = await seedProject(db, "recompletion-proj");
    await seedIssue(db, projectId, statuses.Done, 1);

    // First completion.
    const first = makeBoardEvents();
    expect(await reconcileProjectCompletion(db, { boardEvents: first.boardEvents })).toBe(1);
    expect(first.broadcasts).toHaveLength(1);

    // New backlog item added → no longer finished → marker reset, no broadcast.
    await seedIssue(db, projectId, statuses.Backlog, 2);
    const second = makeBoardEvents();
    expect(await reconcileProjectCompletion(db, { boardEvents: second.boardEvents })).toBe(1);
    expect(second.broadcasts).toEqual([]);
    const [resetMarker] = await db.select().from(preferences).where(eq(preferences.key, projectCompletionMarkerKey(projectId)));
    expect(resetMarker?.value).toBe("false");

    // Finish the new item → re-announce.
    await db.update(issues).set({ statusId: statuses.Done }).where(eq(issues.issueNumber, 2));
    const third = makeBoardEvents();
    expect(await reconcileProjectCompletion(db, { boardEvents: third.boardEvents })).toBe(1);
    expect(third.broadcasts).toEqual([{ projectId, reason: "project_completed" }]);
  });
});
