import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { mcpError, requireEntity, resolveStatusByName, nextIssueNumber } from "../../db-utils.js";
import { createTestDb } from "../helpers/test-db.js";
import { seedProject } from "../helpers/seed.js";

// ---------------------------------------------------------------------------
// mcpError
// ---------------------------------------------------------------------------
describe("mcpError", () => {
  it("returns a well-formed MCP content block", () => {
    const result = mcpError("something went wrong");
    expect(result).toEqual({
      content: [{ type: "text", text: "something went wrong" }],
    });
  });
});

// ---------------------------------------------------------------------------
// requireEntity
// ---------------------------------------------------------------------------
describe("requireEntity", () => {
  it("returns ok=true with the first row when rows is non-empty", () => {
    const row = { id: "abc", name: "Foo" };
    const result = requireEntity([row], "abc", "Thing");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(row);
    }
  });

  it("returns ok=false with an error response when rows is empty", () => {
    const result = requireEntity([], "abc", "Thing");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.content[0].text).toBe("Thing abc not found");
    }
  });

  it("includes both entity name and id in the error message", () => {
    const result = requireEntity([], "workspace-xyz", "Workspace");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.content[0].text).toContain("Workspace");
      expect(result.error.content[0].text).toContain("workspace-xyz");
    }
  });
});

// ---------------------------------------------------------------------------
// resolveStatusByName
// ---------------------------------------------------------------------------
describe("resolveStatusByName", () => {
  it("returns ok=true with the status ID when the status exists", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);

    const result = await resolveStatusByName(db, schema, projectId, "In Progress");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.statusId).toBe(statusIds["In Progress"]);
    }
  });

  it("returns ok=false with available status names when not found", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);

    const result = await resolveStatusByName(db, schema, projectId, "Nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.content[0].text).toContain("Nonexistent");
      expect(result.error.content[0].text).toContain("Todo");
      expect(result.error.content[0].text).toContain("In Progress");
      expect(result.error.content[0].text).toContain("Done");
    }
  });
});

// ---------------------------------------------------------------------------
// nextIssueNumber
// ---------------------------------------------------------------------------
describe("nextIssueNumber", () => {
  it("returns 1 when no issues exist for the project", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);

    const num = await nextIssueNumber(db, schema, projectId);
    expect(num).toBe(1);
  });

  it("returns max + 1 when issues exist", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    const now = new Date().toISOString();

    // Insert two issues manually
    await db.insert(schema.issues).values([
      { id: "i1", issueNumber: 3, title: "A", priority: "medium", sortOrder: 0, statusId: statusIds["Todo"], projectId, createdAt: now, updatedAt: now },
      { id: "i2", issueNumber: 7, title: "B", priority: "medium", sortOrder: 0, statusId: statusIds["Todo"], projectId, createdAt: now, updatedAt: now },
    ]);

    const num = await nextIssueNumber(db, schema, projectId);
    expect(num).toBe(8);
  });

  it("is scoped per project — other projects' issues don't affect the count", async () => {
    const { db } = createTestDb();
    const { projectId: p1, statusIds: s1 } = await seedProject(db, "Project 1");
    const { projectId: p2, statusIds: s2 } = await seedProject(db, "Project 2");
    const now = new Date().toISOString();

    await db.insert(schema.issues).values({
      id: "other", issueNumber: 100, title: "X", priority: "medium", sortOrder: 0,
      statusId: s2["Todo"], projectId: p2, createdAt: now, updatedAt: now,
    });

    const num = await nextIssueNumber(db, schema, p1);
    expect(num).toBe(1); // p1 has no issues, should start at 1
  });
});
