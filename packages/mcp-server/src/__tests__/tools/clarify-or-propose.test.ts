import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { registerClarifyOrPropose } from "../../tools/clarify-or-propose.js";
import { setupTool, parseResult } from "../helpers/tool-harness.js";
import { seedIssue, seedProject } from "../helpers/seed.js";

describe("clarify_or_propose tool", () => {
  it("persists structured clarifying questions for the interactive UI", async () => {
    const { invoke, db, deps } = setupTool(registerClarifyOrPropose);
    const { projectId, statusIds } = await seedProject(db);
    const issue = await seedIssue(db, projectId, statusIds.Todo);
    await db.insert(schema.workspaces).values({
      id: "ws-clarify",
      issueId: issue.id,
      branch: "feature/clarify",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const data = parseResult(await invoke({
      action: "clarify",
      workspaceId: "ws-clarify",
      summary: "Need a product decision.",
      questions: [{
        header: "Storage",
        question: "Where should artifacts be stored?",
        options: [{ label: "Issue" }, { label: "Workspace" }],
      }],
    }));

    expect(data.ok).toBe(true);
    expect(data.toolUseId).toMatch(/^mcp-clarify-/);
    expect(data.questions[0].question).toBe("Where should artifacts be stored?");

    const comments = await db.select().from(schema.issueComments).where(eq(schema.issueComments.issueId, issue.id));
    expect(comments).toHaveLength(1);
    expect(comments[0].kind).toBe("agent-question");
    expect(comments[0].workspaceId).toBe("ws-clarify");
    expect(JSON.parse(comments[0].payload ?? "{}")).toMatchObject({
      toolUseId: data.toolUseId,
      source: "mcp_clarify_or_propose",
    });
    expect(deps.notifyBoard).toHaveBeenCalledWith(projectId, "mcp_clarifying_question");
  });
});
