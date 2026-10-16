vi.mock("../services/git.service.js", () => ({
  getDiffShortstat: vi.fn(async () => ({ filesChanged: 0, insertions: 0, deletions: 0 })),
  getLatestCommit: vi.fn(async () => null),
  getCommitCountAhead: vi.fn(async () => 0),
  detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projects, projectStatuses } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createProjectService } from "../services/project.service.js";

// #1541: the Completed grid pages Done/Cancelled beyond the board payload's cap and searches them
// server-side.
describe("getCompletedPage (#1541)", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let projectId: string;

  beforeEach(async () => {
    ({ db } = createTestDb());
    const now = new Date().toISOString();
    projectId = randomUUID();
    const doneId = randomUUID();
    const cancelledId = randomUUID();
    const todoId = randomUUID();
    await db.insert(projects).values({
      id: projectId, name: "T", repoPath: "/repo", repoName: "repo", defaultBranch: "master", createdAt: now, updatedAt: now,
    });
    await db.insert(projectStatuses).values([
      { id: todoId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now },
      { id: doneId, projectId, name: "Done", sortOrder: 1, isDefault: false, createdAt: now },
      { id: cancelledId, projectId, name: "Cancelled", sortOrder: 2, isDefault: false, createdAt: now },
    ]);
    const rows = [];
    for (let n = 1; n <= 120; n++) {
      const changed = new Date(Date.now() - (200 - n) * 60_000).toISOString();
      rows.push({
        id: randomUUID(), issueNumber: n, title: n === 3 ? "needle ticket" : `ticket ${n}`,
        priority: "medium", sortOrder: n, statusId: n % 10 === 0 ? cancelledId : doneId,
        projectId, createdAt: now, updatedAt: changed, statusChangedAt: changed,
      });
    }
    rows.push({
      id: randomUUID(), issueNumber: 999, title: "still open", priority: "medium", sortOrder: 0,
      statusId: todoId, projectId, createdAt: now, updatedAt: now,
    });
    await db.insert(issues).values(rows);
  });

  it("pages Done+Cancelled newest first and reports the total", async () => {
    const svc = createProjectService({ database: db });
    const first = await svc.getCompletedPage(projectId, { offset: 0, limit: 50 });
    expect(first.total).toBe(120);
    expect(first.issues).toHaveLength(50);
    expect(first.issues[0].issueNumber).toBe(120);
    const last = await svc.getCompletedPage(projectId, { offset: 100, limit: 50 });
    expect(last.issues).toHaveLength(20);
    expect(last.issues.at(-1)?.issueNumber).toBe(1);
    expect(first.issues.some((i) => i.issueNumber === 999)).toBe(false);
  });

  it("finds an old ticket by title and by #number", async () => {
    const svc = createProjectService({ database: db });
    const byTitle = await svc.getCompletedPage(projectId, { offset: 0, limit: 50, query: "NEEDLE" });
    expect(byTitle.total).toBe(1);
    expect(byTitle.issues[0].issueNumber).toBe(3);
    const byNumber = await svc.getCompletedPage(projectId, { offset: 0, limit: 50, query: "#119" });
    expect(byNumber.issues.map((i) => i.issueNumber)).toContain(119);
  });
});
