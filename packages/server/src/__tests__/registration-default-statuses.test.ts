import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, projectStatuses } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import { initializeProjectStatuses, DEFAULT_STATUSES } from "../repositories/issue.repository.js";

// #772: every project-registration path now seeds the canonical status set via
// initializeProjectStatuses. Missing statuses make POST /api/issues/batch 400
// ("No statuses found for project"); a missing Backlog column breaks auto-driven
// Backlog-pull. Guard the shape of what fresh registration produces.
describe("initializeProjectStatuses (registration default statuses)", () => {
  it("seeds the canonical set including Backlog at sortOrder -1", async () => {
    const { db } = createTestDb();
    const projectId = randomUUID();
    const now = new Date().toISOString();

    // project_statuses FK-references projects; seed a bare project (no statuses) first.
    await db.insert(projects).values({
      id: projectId,
      name: "fresh",
      repoPath: "/tmp/fresh",
      repoName: "fresh",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });

    await initializeProjectStatuses(projectId, now, db);

    const rows = await db
      .select()
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, projectId));

    // One row per canonical status, no duplicates.
    expect(rows).toHaveLength(DEFAULT_STATUSES.length);

    const backlog = rows.find((r) => r.name === "Backlog");
    expect(backlog).toBeDefined();
    expect(backlog?.sortOrder).toBe(-1);

    // Exactly one default status, and it is Todo (the entry agents land on).
    const defaults = rows.filter((r) => r.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].name).toBe("Todo");

    // Backlog-pull, In Review, AI Reviewed and the terminal columns are all present.
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(
      ["AI Reviewed", "Backlog", "Cancelled", "Done", "In Progress", "In Review", "Todo"].sort(),
    );
  });
});
