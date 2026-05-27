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
});
