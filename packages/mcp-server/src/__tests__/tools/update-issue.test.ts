import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { registerUpdateIssue } from "../../tools/update-issue.js";
import { setupTool, parseResult } from "../helpers/tool-harness.js";
import { seedProject, seedIssue } from "../helpers/seed.js";

describe("update_issue tool", () => {
  it("updates priority and moves the issue to a new status by name", async () => {
    const { invoke, db, deps } = setupTool(registerUpdateIssue);
    const { projectId, statusIds } = await seedProject(db);
    const { id } = await seedIssue(db, projectId, statusIds["Todo"], { title: "T", priority: "low" });

    const data = parseResult(await invoke({ issueId: id, priority: "critical", statusName: "In Progress" }));

    expect(data.updated).toContain("priority");
    expect(data.updated).toContain("statusId");

    const rows = await db.select().from(schema.issues).where(eq(schema.issues.id, id));
    expect(rows[0].priority).toBe("critical");
    expect(rows[0].statusId).toBe(statusIds["In Progress"]);
    expect(deps.notifyBoard).toHaveBeenCalledWith(projectId, "mcp_update_issue");
  });

  it("returns an error for an unknown status name", async () => {
    const { invoke, db } = setupTool(registerUpdateIssue);
    const { projectId, statusIds } = await seedProject(db);
    const { id } = await seedIssue(db, projectId, statusIds["Todo"]);

    const result = await invoke({ issueId: id, statusName: "Nonexistent" });
    expect(result.content[0].text).toContain("not found");
  });

  it("tags.add sets a tag by name, creating it when absent, idempotently (#1032)", async () => {
    const { invoke, db } = setupTool(registerUpdateIssue);
    const { projectId, statusIds } = await seedProject(db);
    const { id } = await seedIssue(db, projectId, statusIds["Todo"]);

    const first = parseResult(await invoke({ issueId: id, tags: { add: ["harness"] } }));
    expect(first.updated).toContain("tags");

    const tagRows = await db.select().from(schema.tags).where(eq(schema.tags.name, "harness"));
    expect(tagRows).toHaveLength(1);
    const links = await db.select().from(schema.issueTags).where(eq(schema.issueTags.issueId, id));
    expect(links.map((l) => l.tagId)).toEqual([tagRows[0].id]);

    // Second add of the same name: no duplicate tag, no duplicate link, and `tags` is not reported.
    const second = parseResult(await invoke({ issueId: id, tags: { add: ["harness"] } }));
    expect(second.updated).not.toContain("tags");
    expect(await db.select().from(schema.tags).where(eq(schema.tags.name, "harness"))).toHaveLength(1);
    expect(await db.select().from(schema.issueTags).where(eq(schema.issueTags.issueId, id))).toHaveLength(1);
  });

  it("tags.remove drops a tag by name and ignores names the issue does not carry (#1032)", async () => {
    const { invoke, db } = setupTool(registerUpdateIssue);
    const { projectId, statusIds } = await seedProject(db);
    const { id } = await seedIssue(db, projectId, statusIds["Todo"]);
    await invoke({ issueId: id, tags: { add: ["harness", "ui"] } });

    const removed = parseResult(await invoke({ issueId: id, tags: { remove: ["harness", "never-there"] } }));
    expect(removed.updated).toContain("tags");

    const remaining = await db.select({ name: schema.tags.name })
      .from(schema.issueTags)
      .innerJoin(schema.tags, eq(schema.issueTags.tagId, schema.tags.id))
      .where(eq(schema.issueTags.issueId, id));
    expect(remaining.map((r) => r.name)).toEqual(["ui"]);
    // The tag row itself survives a removal — only the link goes.
    expect(await db.select().from(schema.tags).where(eq(schema.tags.name, "harness"))).toHaveLength(1);

    const noop = parseResult(await invoke({ issueId: id, tags: { remove: ["never-there"] } }));
    expect(noop.updated).not.toContain("tags");
  });
});
