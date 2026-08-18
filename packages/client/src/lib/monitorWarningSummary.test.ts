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
    const warnings = [dirty("agentic-kanban"), dirty("comet"), stalled("comet")];

    expect(warningsForProject(warnings, "comet")).toHaveLength(2);
    expect(warningsForProject(warnings, "agentic-kanban")).toHaveLength(1);
  });

  it("reports NO warnings for a board with none of its own", () => {
    // The reported defect: the comet board rendered red for `agentic-kanban: dirty main
    // checkout`, a project the user cannot act on from the board they are looking at.
    expect(warningsForProject([dirty("agentic-kanban")], "comet")).toEqual([]);
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
    expect(describeMonitorWarnings([stalled("comet")])).toBe("Board monitor warning — autodrive stalled");
    expect(describeMonitorWarnings([dirty("comet")])).toBe("Board monitor warning — dirty main checkout");
  });

  it("counts multiple warnings and lists each DISTINCT cause once", () => {
    expect(describeMonitorWarnings([dirty("comet"), stalled("comet")]))
      .toBe("Board monitor: 2 warnings — dirty main checkout, autodrive stalled");
    expect(describeMonitorWarnings([dirty("comet"), dirty("comet")]))
      .toBe("Board monitor: 2 warnings — dirty main checkout");
  });
});

describe("sortProjectHealth (#637)", () => {
  const p = (id: string, warnings: string[] = []) => ({ id, warnings });

  it("puts the project the dialog was opened from first", () => {
    const sorted = sortProjectHealth([p("a"), p("b"), p("comet")], "comet");
    expect(sorted.map((x) => x.id)).toEqual(["comet", "a", "b"]);
  });

  it("ranks warned projects above quiet ones, and is otherwise stable", () => {
    const sorted = sortProjectHealth([p("a"), p("b", ["dirty"]), p("comet"), p("c", ["dirty"])], "comet");
    expect(sorted.map((x) => x.id)).toEqual(["comet", "b", "c", "a"]);
  });

  it("leaves the server order alone when the active project is not in the list", () => {
    const sorted = sortProjectHealth([p("a"), p("b")], null);
    expect(sorted.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const input = [p("a"), p("comet")];
    sortProjectHealth(input, "comet");
    expect(input.map((x) => x.id)).toEqual(["a", "comet"]);
  });
});
