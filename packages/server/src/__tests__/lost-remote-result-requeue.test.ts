// @covers workflow.exit.lost-remote-result [workflow,state-transition,resilience]
/**
 * #1582: a remote session exits with "no incoming ref" and its branch has 0 commits — the issue
 * returns to Todo and the workspace closes (slot freed) instead of sitting In Review.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { isLostRemoteResult, requeueLostRemoteResult } from "../startup/exit/lost-remote-result-exit.js";

const LOST = "Worker result could not be landed on feature/ak-1574-x: no incoming ref refs/kanban/incoming/feature/ak-1574-x";

async function seed(statusName: string) {
  const { db } = createTestDb();
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  const ids: Record<string, string> = {};
  await db.insert(projects).values({ id: projectId, name: "T", repoPath: "/repo", repoName: "repo", defaultBranch: "master", createdAt: now, updatedAt: now });
  for (const [i, name] of ["Todo", "In Progress", "In Review"].entries()) {
    ids[name] = randomUUID();
    await db.insert(projectStatuses).values({ id: ids[name], projectId, name, sortOrder: i, isDefault: false, createdAt: now });
  }
  await db.insert(issues).values({ id: issueId, issueNumber: 1, title: "I", priority: "medium", sortOrder: 0, statusId: ids[statusName], projectId, createdAt: now, updatedAt: now });
  await db.insert(workspaces).values({ id: workspaceId, issueId, branch: "feature/ak-1", workingDir: "/repo/.worktrees/x", baseBranch: "master", isDirect: false, status: "idle", readyForMerge: false, mergedAt: null, provider: "claude", createdAt: now, updatedAt: now });
  const statuses = Object.entries(ids).map(([name, id]) => ({ id, name }));
  return { db, issueId, workspaceId, statuses, now, todoId: ids.Todo };
}

describe("lost remote result requeue (#1582)", () => {
  it("recognises the not-landed transcript", () => {
    expect(isLostRemoteResult(LOST)).toBe(true);
    expect(isLostRemoteResult("some other failure")).toBe(false);
  });

  for (const status of ["In Review", "In Progress"]) {
    it(`returns a ${status} issue to Todo and closes the workspace when there are 0 commits`, async () => {
      const s = await seed(status);
      const moved = await requeueLostRemoteResult({ database: s.db, workspaceId: s.workspaceId, issueId: s.issueId, sessionId: "sess", stderr: LOST, commitsAhead: 0, statuses: s.statuses, now: s.now });
      expect(moved).toBe(true);
      const [issue] = await s.db.select().from(issues).where(eq(issues.id, s.issueId));
      expect(issue.statusId).toBe(s.todoId);
      const [ws] = await s.db.select().from(workspaces).where(eq(workspaces.id, s.workspaceId));
      expect(ws.status).toBe("closed");
    });
  }

  it("leaves the issue alone when the branch has commits", async () => {
    const s = await seed("In Review");
    const moved = await requeueLostRemoteResult({ database: s.db, workspaceId: s.workspaceId, issueId: s.issueId, sessionId: "sess", stderr: LOST, commitsAhead: 2, statuses: s.statuses, now: s.now });
    expect(moved).toBe(false);
  });

  it("leaves the issue alone for an unrelated failure", async () => {
    const s = await seed("In Progress");
    const moved = await requeueLostRemoteResult({ database: s.db, workspaceId: s.workspaceId, issueId: s.issueId, sessionId: "sess", stderr: "boom", commitsAhead: 0, statuses: s.statuses, now: s.now });
    expect(moved).toBe(false);
  });
});
