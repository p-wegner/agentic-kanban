import { describe, it, expect } from "vitest";
import type { StatusWithIssues } from "@agentic-kanban/shared";
import type { StaleWorktreeEntry } from "../hooks/useStaleWorkspaceManager.js";
import {
  selectIssuesWithWorkspaces,
  countActiveWorkspaces,
  collectIdleWorkspaceIds,
  matchesWorkspaceFilter,
  matchesStaleFilter,
  type IssueWithMaybeProject,
  type CrossProjectGroup,
} from "./allWorkspacesFilter.js";

const issue = (over: Partial<IssueWithMaybeProject> & { id: string }): IssueWithMaybeProject =>
  ({ issueNumber: 1, title: "Title", statusName: "Todo", projectId: "p", ...over } as IssueWithMaybeProject);

const withWs = (id: string, status: string, extra: Record<string, unknown> = {}, title = "Title") =>
  issue({ id, title, workspaceSummary: { total: 1, main: { id: `${id}-ws`, status, ...extra } } as never });

describe("selectIssuesWithWorkspaces", () => {
  it("flattens cross-project groups and tags projectName in 'all' mode", () => {
    const groups: CrossProjectGroup[] = [
      { projectId: "p1", projectName: "Proj One", issues: [issue({ id: "a" })] },
      { projectId: "p2", projectName: "Proj Two", issues: [issue({ id: "b" })] },
    ];
    const out = selectIssuesWithWorkspaces("all", groups, []);
    expect(out.map((i) => [i.id, i.projectName])).toEqual([
      ["a", "Proj One"],
      ["b", "Proj Two"],
    ]);
  });

  it("returns [] in 'all' mode when cross-project data is null", () => {
    expect(selectIssuesWithWorkspaces("all", null, [])).toEqual([]);
  });

  it("in single-project mode keeps only issues with ≥1 workspace", () => {
    const columns = [
      { issues: [withWs("a", "active"), issue({ id: "b" })] },
    ] as unknown as StatusWithIssues[];
    const out = selectIssuesWithWorkspaces("p", null, columns);
    expect(out.map((i) => i.id)).toEqual(["a"]);
  });
});

describe("countActiveWorkspaces / collectIdleWorkspaceIds", () => {
  const issues = [withWs("a", "active"), withWs("b", "reviewing"), withWs("c", "fixing"), withWs("d", "idle"), withWs("e", "closed")];
  it("counts active/reviewing/fixing", () => {
    expect(countActiveWorkspaces(issues)).toBe(3);
  });
  it("collects only idle main-workspace ids", () => {
    expect(collectIdleWorkspaceIds(issues)).toEqual(["d-ws"]);
  });
});

describe("matchesWorkspaceFilter", () => {
  const active = withWs("a", "active", { branch: "feature/x" }, "Build the thing");
  const reviewing = withWs("b", "reviewing");
  const idle = withWs("c", "idle");

  it("'all' and 'stale' bypass the status check", () => {
    expect(matchesWorkspaceFilter(idle, "all", "")).toBe(true);
    expect(matchesWorkspaceFilter(idle, "stale", "")).toBe(true);
  });
  it("'active' matches active|reviewing|fixing", () => {
    expect(matchesWorkspaceFilter(active, "active", "")).toBe(true);
    expect(matchesWorkspaceFilter(reviewing, "active", "")).toBe(true);
    expect(matchesWorkspaceFilter(idle, "active", "")).toBe(false);
  });
  it("other chips require exact status equality", () => {
    expect(matchesWorkspaceFilter(idle, "idle", "")).toBe(true);
    expect(matchesWorkspaceFilter(active, "idle", "")).toBe(false);
  });
  it("search ORs case-insensitively over title / branch / projectName", () => {
    expect(matchesWorkspaceFilter(active, "all", "THE THING")).toBe(true); // title
    expect(matchesWorkspaceFilter(active, "all", "feature/")).toBe(true); // branch
    const cross = issue({ id: "z", title: "T", projectName: "Acme", workspaceSummary: { total: 1, main: { id: "z-ws", status: "active" } } as never });
    expect(matchesWorkspaceFilter(cross, "all", "acme")).toBe(true); // projectName
    expect(matchesWorkspaceFilter(active, "all", "no-match")).toBe(false);
  });
});

describe("matchesStaleFilter", () => {
  const entry = { branch: "feature/ak-9-x", issueTitle: "Fix the bug", issueNumber: 42 } as StaleWorktreeEntry;
  it("matches all when query is blank", () => {
    expect(matchesStaleFilter(entry, "  ")).toBe(true);
  });
  it("matches branch / title / issue number case-insensitively", () => {
    expect(matchesStaleFilter(entry, "AK-9")).toBe(true);
    expect(matchesStaleFilter(entry, "fix the")).toBe(true);
    expect(matchesStaleFilter(entry, "42")).toBe(true);
    expect(matchesStaleFilter(entry, "nope")).toBe(false);
  });
});
