import { describe, it, expect } from "vitest";
import { registerListIssues } from "../../tools/list-issues.js";
import { setupTool, parseResult } from "../helpers/tool-harness.js";
import { seedProject, seedIssue } from "../helpers/seed.js";

describe("list_issues tool", () => {
  it("returns all issues for a project", async () => {
    const { invoke, db } = setupTool(registerListIssues);
    const { projectId, statusIds } = await seedProject(db);
    await seedIssue(db, projectId, statusIds["Todo"], { title: "A", issueNumber: 1 });
    await seedIssue(db, projectId, statusIds["In Progress"], { title: "B", issueNumber: 2 });

    const data = parseResult(await invoke({ projectId }));

    expect(data).toHaveLength(2);
    expect(data.map((i: any) => i.title).sort()).toEqual(["A", "B"]);
  });

  it("filters by status name", async () => {
    const { invoke, db } = setupTool(registerListIssues);
    const { projectId, statusIds } = await seedProject(db);
    await seedIssue(db, projectId, statusIds["Todo"], { title: "todo-issue", issueNumber: 1 });
    await seedIssue(db, projectId, statusIds["In Progress"], { title: "wip-issue", issueNumber: 2 });

    const data = parseResult(await invoke({ projectId, status: "In Progress" }));

    expect(data).toHaveLength(1);
    expect(data[0].title).toBe("wip-issue");
    expect(data[0].statusName).toBe("In Progress");
  });
});
