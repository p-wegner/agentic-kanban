import { describe, it, expect } from "vitest";
import type { ContributionActorRow } from "@agentic-kanban/shared";
import {
  barPercent,
  buildRangeSearch,
  formatMetric,
  parseRangeSearch,
  resolveRangeWindow,
  sortContributionRows,
} from "./contributions.js";
import { parseAppPath, buildAppPath } from "./appRoutes.js";

function row(actor: string, over: Partial<ContributionActorRow> = {}): ContributionActorRow {
  return {
    actor, unset: false, doneIssues: 0, mergedIssues: 0, workspaces: 0, sessions: 0,
    failedSessions: 0, abortedSessions: 0, mergedCommits: null, linesAdded: null, linesRemoved: null,
    inputTokens: null, outputTokens: null, costUsd: null, activeMs: null, ...over,
  };
}

describe("contributions range <-> URL", () => {
  it("round-trips presets and custom ranges, preserving unrelated params", () => {
    expect(parseRangeSearch("")).toEqual({ range: "all", customFrom: "", customTo: "" });
    expect(parseRangeSearch("?range=bogus").range).toBe("all");
    const custom = { range: "custom" as const, customFrom: "2026-01-02", customTo: "2026-02-03" };
    expect(parseRangeSearch(buildRangeSearch("", custom))).toEqual(custom);
    expect(buildRangeSearch("?x=1&range=7d", { range: "all", customFrom: "", customTo: "" })).toBe("?x=1");
    expect(buildRangeSearch("?x=1", { ...custom, range: "7d" })).toBe("?x=1&range=7d");
  });

  it("snaps preset windows to the UTC day and ends custom ranges at end of day", () => {
    const now = Date.parse("2026-03-10T15:30:00.000Z");
    expect(resolveRangeWindow({ range: "7d", customFrom: "", customTo: "" }, now)).toEqual({ from: "2026-03-04T00:00:00.000Z" });
    expect(resolveRangeWindow({ range: "all", customFrom: "", customTo: "" }, now)).toEqual({});
    expect(resolveRangeWindow({ range: "custom", customFrom: "2026-01-02", customTo: "2026-02-03" }, now)).toEqual({
      from: "2026-01-02T00:00:00.000Z",
      to: "2026-02-03T23:59:59.999Z",
    });
  });
});

describe("contributions formatting and sorting", () => {
  it("renders missing metrics as an en dash, never 0", () => {
    expect(formatMetric(null, "count")).toBe("–");
    expect(formatMetric(null, "usd")).toBe("–");
    expect(formatMetric(0, "count")).toBe("0");
    expect(formatMetric(1234, "count")).toBe("1,234");
    expect(formatMetric(2, "usd")).toBe("$2.00");
    expect(formatMetric(90_000, "duration")).toBe("2m");
    expect(formatMetric(3_900_000, "duration")).toBe("1h 5m");
  });

  it("sorts missing values last in both directions", () => {
    const rows = [row("a", { costUsd: null }), row("b", { costUsd: 5 }), row("c", { costUsd: 1 })];
    expect(sortContributionRows(rows, { key: "costUsd", dir: "desc" }).map((r) => r.actor)).toEqual(["b", "c", "a"]);
    expect(sortContributionRows(rows, { key: "costUsd", dir: "asc" }).map((r) => r.actor)).toEqual(["c", "b", "a"]);
    expect(sortContributionRows(rows, { key: "actor", dir: "desc" }).map((r) => r.actor)).toEqual(["c", "b", "a"]);
  });

  it("scales bars against the maximum", () => {
    expect(barPercent(5, 10)).toBe(50);
    expect(barPercent(null, 10)).toBe(0);
    expect(barPercent(3, 0)).toBe(0);
  });
});

describe("contributions routing", () => {
  it("is reachable at /p/<slug>/contributions with the grouping as the tab", () => {
    expect(parseAppPath("/p/demo/contributions")).toMatchObject({ view: "contributions", tab: "provider" });
    expect(parseAppPath("/p/demo/contributions/model")).toMatchObject({ view: "contributions", tab: "model", tabIsExplicit: true });
    expect(buildAppPath({ projectSlug: "demo", view: "contributions", tab: "author" })).toBe("/p/demo/contributions/author");
  });
});
