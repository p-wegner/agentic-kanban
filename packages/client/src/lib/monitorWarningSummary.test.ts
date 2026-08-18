import { describe, it, expect } from "vitest";
import { warningsForProject, describeMonitorWarnings } from "./monitorWarningSummary.js";
import type { MonitorWarning } from "./monitor-popover.js";
import { sortProjectHealth } from "./projectHealthOrder.js";

const dirty = (projectId: string, projectName = projectId): MonitorWarning => ({
  projectId, projectName, repoPath: `/repo/${projectId}`, detectedAt: "2026-08-18T10:00:00.000Z",
  fileCount: 4, files: ["a.ts"], message: `${projectName}: dirty main checkout — 4 tracked source changes`,
});

const stalled = (projectId: string, projectName = projectId): MonitorWarning => ({
  type: "autodrive_stall", projectId, projectName, detectedAt: "2026-08-18T10:00:00.000Z",
  thresholdMin: 30, stalledForMin: 91, lastProgressAt: "2026-08-18T08:29:00.000Z",
  activeIssueCount: 1, workspaceIds: ["ws-1"], issueNumbers: [637], cause: "no_agent_output",
  message: `${projectName}: autodrive stalled`,
});

describe("warningsForProject (#637)", () => {
  it("keeps only the active project's warnings", () => {
    const warnings = [dirty("agentic-kanban"), dirty("client-a"), stalled("client-a")];

    expect(warningsForProject(warnings, "client-a")).toHaveLength(2);
    expect(warningsForProject(warnings, "agentic-kanban")).toHaveLength(1);
  });

  it("reports NO warnings for a board with none of its own", () => {
    // The reported defect: the client-a board rendered red for `agentic-kanban: dirty main
    // checkout`, a project the user cannot act on from the board they are looking at.
    expect(warningsForProject([dirty("agentic-kanban")], "client-a")).toEqual([]);
  });

  it("is empty when there is no active project or no warnings", () => {
    expect(warningsForProject([dirty("a")], null)).toEqual([]);
    expect(warningsForProject(undefined, "a")).toEqual([]);
    expect(warningsForProject([], "a")).toEqual([]);
  });
});

describe("describeMonitorWarnings (#637)", () => {
  it("returns null with nothing to report, so the button keeps its normal title", () => {
    expect(describeMonitorWarnings([])).toBeNull();
  });

  it("names the actual cause instead of always claiming a dirty checkout", () => {
    // The hardcoded literal made an autodrive stall describe itself as a dirty checkout —
    // a different failure with a different remedy.
    expect(describeMonitorWarnings([stalled("client-a")])).toBe("Board monitor warning — autodrive stalled");
    expect(describeMonitorWarnings([dirty("client-a")])).toBe("Board monitor warning — dirty main checkout");
  });

  it("counts multiple warnings and lists each DISTINCT cause once", () => {
    expect(describeMonitorWarnings([dirty("client-a"), stalled("client-a")]))
      .toBe("Board monitor: 2 warnings — dirty main checkout, autodrive stalled");
    expect(describeMonitorWarnings([dirty("client-a"), dirty("client-a")]))
      .toBe("Board monitor: 2 warnings — dirty main checkout");
  });
});

describe("sortProjectHealth (#637)", () => {
  const p = (id: string, warnings: string[] = []) => ({ id, warnings });

  it("puts the project the dialog was opened from first", () => {
    const sorted = sortProjectHealth([p("a"), p("b"), p("client-a")], "client-a");
    expect(sorted.map((x) => x.id)).toEqual(["client-a", "a", "b"]);
  });

  it("ranks warned projects above quiet ones, and is otherwise stable", () => {
    const sorted = sortProjectHealth([p("a"), p("b", ["dirty"]), p("client-a"), p("c", ["dirty"])], "client-a");
    expect(sorted.map((x) => x.id)).toEqual(["client-a", "b", "c", "a"]);
  });

  it("leaves the server order alone when the active project is not in the list", () => {
    const sorted = sortProjectHealth([p("a"), p("b")], null);
    expect(sorted.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const input = [p("a"), p("client-a")];
    sortProjectHealth(input, "client-a");
    expect(input.map((x) => x.id)).toEqual(["a", "client-a"]);
  });
});
