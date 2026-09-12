import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { registerCreateIssue } from "../../tools/create-issue.js";
import { setupTool, parseResult } from "../helpers/tool-harness.js";
import { seedProject, setActiveProject } from "../helpers/seed.js";

describe("create_issue tool", () => {
  it("creates an issue in the given project with an auto-incremented issue number", async () => {
    const { invoke, db, deps } = setupTool(registerCreateIssue);
    const { projectId } = await seedProject(db);

    const result = await invoke({ title: "First issue", priority: "high", projectId });
    const data = parseResult(result);

    expect(data.title).toBe("First issue");
    expect(data.issueNumber).toBe(1);
    expect(data.priority).toBe("high");

    const rows = await db.select().from(schema.issues).where(eq(schema.issues.id, data.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].projectId).toBe(projectId);
    // Board was notified of the mutation
    expect(deps.notifyBoard).toHaveBeenCalledWith(projectId, "mcp_create_issue");

    // A second issue increments the number
    const second = parseResult(await invoke({ title: "Second issue", projectId }));
    expect(second.issueNumber).toBe(2);
  });

  it("falls back to the active project when no projectId is given, and errors when none is set", async () => {
    const { invoke, db } = setupTool(registerCreateIssue);
    const { projectId } = await seedProject(db);

    // No active project preference yet → error
    const noActive = await invoke({ title: "orphan" });
    expect(noActive.content[0].text).toContain("No active project");

    // Once set, the issue lands in the active project
    await setActiveProject(db, projectId);
    const data = parseResult(await invoke({ title: "Active issue" }));
    const rows = await db.select().from(schema.issues).where(eq(schema.issues.id, data.id));
    expect(rows[0].projectId).toBe(projectId);
  });

  it("ECHOES the resolved project (id + name) so an implicit-fallback mis-filing is visible (#335)", async () => {
    const { invoke, db } = setupTool(registerCreateIssue);
    const { projectId } = await seedProject(db, "habitloop");
    await setActiveProject(db, projectId);

    // The caller omitted projectId, so the project came from the global mutable
    // activeProjectId preference. The response must NAME it — previously the
    // response carried no project at all, which is what made mis-filing silent.
    const data = parseResult(await invoke({ title: "board bug filed from another repo" }));
    expect(data.projectId).toBe(projectId);
    expect(data.projectName).toBe("habitloop");
  });

  // #1108 gap 3: a ticket must be able to be born already tagged, so filing one for a
  // maintenance window doesn't have to win a race against the monitor.
  it("applies requested tags, creating an unknown tag on the fly", async () => {
    const { invoke, db } = setupTool(registerCreateIssue);
    const { projectId } = await seedProject(db);

    const data = parseResult(await invoke({ title: "held for maintenance", projectId, tags: ["no-auto-start", "brand-new"] }));

    const rows = await db.select({ name: schema.tags.name })
      .from(schema.issueTags)
      .innerJoin(schema.tags, eq(schema.issueTags.tagId, schema.tags.id))
      .where(eq(schema.issueTags.issueId, data.id));
    expect(rows.map((r) => r.name).sort()).toEqual(["brand-new", "no-auto-start"]);
  });

  it("noAutoStart:true is shorthand for tags:['no-auto-start'], reusing an existing tag case-insensitively", async () => {
    const { invoke, db } = setupTool(registerCreateIssue);
    const { projectId } = await seedProject(db);
    await db.insert(schema.tags).values({ id: "seeded-tag", name: "No-Auto-Start", color: null, createdAt: new Date().toISOString() });

    const data = parseResult(await invoke({ title: "shorthand", projectId, noAutoStart: true }));

    const rows = await db.select().from(schema.issueTags).where(eq(schema.issueTags.issueId, data.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].tagId).toBe("seeded-tag");
  });
});
