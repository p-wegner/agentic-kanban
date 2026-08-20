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

  // #344: descriptions are ~70% of an issue list's payload (509 KB across 323 issues on
  // the dev project), and this tool's output is serialized straight into an agent's
  // context on every call. Listing is for FINDING an issue; get_issue is for reading one.
  describe("description payload (#344)", () => {
    it("omits descriptions by default while keeping every field needed to find an issue", async () => {
      const { invoke, db } = setupTool(registerListIssues);
      const { projectId, statusIds } = await seedProject(db);
      await seedIssue(db, projectId, statusIds["Todo"], {
        title: "Has a long description",
        issueNumber: 1,
        description: "x".repeat(5000),
      });

      const data = parseResult(await invoke({ projectId }));

      expect(data).toHaveLength(1);
      expect(data[0]).not.toHaveProperty("description");
      // The fields that make the row useful for finding/selecting an issue must remain.
      expect(data[0].title).toBe("Has a long description");
      expect(data[0].issueNumber).toBe(1);
      expect(data[0].statusName).toBe("Todo");
      expect(typeof data[0].id).toBe("string");
      expect(data[0].priority).toBe("medium");
      expect(data[0].projectId).toBe(projectId);
    });

    it("includes them on explicit opt-in, so nothing is unrecoverable", async () => {
      const { invoke, db } = setupTool(registerListIssues);
      const { projectId, statusIds } = await seedProject(db);
      await seedIssue(db, projectId, statusIds["Todo"], {
        title: "Has a long description",
        issueNumber: 1,
        description: "full text here",
      });

      const data = parseResult(await invoke({ projectId, includeDescription: true }));

      expect(data[0].description).toBe("full text here");
    });

    it("still filters correctly when descriptions are omitted", async () => {
      // The omission is a projection change; the tag/status/priority/blocked filters all
      // run over the projected rows, so this guards against the projection breaking them.
      const { invoke, db } = setupTool(registerListIssues);
      const { projectId, statusIds } = await seedProject(db);
      await seedIssue(db, projectId, statusIds["Todo"], { title: "todo", issueNumber: 1, description: "a".repeat(1000) });
      await seedIssue(db, projectId, statusIds["In Progress"], { title: "wip", issueNumber: 2, description: "b".repeat(1000), priority: "critical" });

      const byStatus = parseResult(await invoke({ projectId, status: "In Progress" }));
      expect(byStatus.map((i: any) => i.title)).toEqual(["wip"]);
      expect(byStatus[0]).not.toHaveProperty("description");

      const byPriority = parseResult(await invoke({ projectId, priority: "critical" }));
      expect(byPriority.map((i: any) => i.title)).toEqual(["wip"]);

      const byNumber = parseResult(await invoke({ projectId, issueNumber: 1 }));
      expect(byNumber.map((i: any) => i.title)).toEqual(["todo"]);
    });
  });
});
