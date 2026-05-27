import { describe, it, expect } from "vitest";
import { registerGetIssue } from "../../tools/get-issue.js";
import { setupTool, parseResult } from "../helpers/tool-harness.js";
import { seedProject, seedIssue } from "../helpers/seed.js";

describe("get_issue tool", () => {
  it("resolves an issue by numeric issue number and includes workspaces + dependencies", async () => {
    const { invoke, db } = setupTool(registerGetIssue);
    const { projectId, statusIds } = await seedProject(db);
    const { id } = await seedIssue(db, projectId, statusIds["Todo"], { title: "Numbered", issueNumber: 42 });

    const data = parseResult(await invoke({ issueId: "42" }));

    expect(data.id).toBe(id);
    expect(data.title).toBe("Numbered");
    expect(data.statusName).toBe("Todo");
    expect(Array.isArray(data.workspaces)).toBe(true);
    expect(data.dependencies).toEqual({ outgoing: [], incoming: [] });
    expect(data.isBlocked).toBe(false);
  });

  it("returns a not-found message for an unknown id", async () => {
    const { invoke, db } = setupTool(registerGetIssue);
    await seedProject(db);

    const result = await invoke({ issueId: "does-not-exist" });
    expect(result.content[0].text).toContain("not found");
  });
});
