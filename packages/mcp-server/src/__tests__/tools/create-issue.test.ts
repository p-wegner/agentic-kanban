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
});
