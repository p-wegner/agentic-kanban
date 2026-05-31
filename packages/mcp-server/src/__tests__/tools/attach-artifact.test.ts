import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { registerAttachArtifact } from "../../tools/attach-artifact.js";
import { setupTool, parseResult } from "../helpers/tool-harness.js";
import { seedIssue, seedProject } from "../helpers/seed.js";

describe("attach_artifact tool", () => {
  it("attaches a text artifact to an issue", async () => {
    const { invoke, db, deps } = setupTool(registerAttachArtifact);
    const { projectId, statusIds } = await seedProject(db);
    const issue = await seedIssue(db, projectId, statusIds.Todo);

    const data = parseResult(await invoke({
      issueId: issue.id,
      type: "text",
      mimeType: "text/markdown",
      content: "# Artifact",
      caption: "phase-artifact:tasks",
    }));

    expect(data.issueId).toBe(issue.id);
    expect(data.type).toBe("text");
    expect(data.caption).toBe("phase-artifact:tasks");

    const rows = await db.select().from(schema.issueArtifacts).where(eq(schema.issueArtifacts.id, data.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("# Artifact");
    expect(deps.notifyBoard).toHaveBeenCalledWith(projectId, "mcp_attach_artifact");
  });

  it("resolves the issue from workspaceId", async () => {
    const { invoke, db } = setupTool(registerAttachArtifact);
    const { projectId, statusIds } = await seedProject(db);
    const issue = await seedIssue(db, projectId, statusIds.Todo);
    await db.insert(schema.workspaces).values({
      id: "ws-1",
      issueId: issue.id,
      branch: "feature/test",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const data = parseResult(await invoke({
      workspaceId: "ws-1",
      type: "link",
      content: "https://example.com/design",
      caption: "Design reference",
    }));

    expect(data.issueId).toBe(issue.id);
    expect(data.workspaceId).toBe("ws-1");
  });
});
