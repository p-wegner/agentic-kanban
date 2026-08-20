/**
 * #548 — one `ak-<N>` parser, and the loose ones it replaces were a work-losing bug class.
 *
 * Five call sites re-derived "which issue does this branch name encode?" with five different
 * acceptance rules. That is not a tidiness problem: `hand-merged-branch-reconciler` uses the
 * answer to force an issue to Done, so a wrong match closes live work — the shape behind the
 * recycled-number incident in #146.
 *
 * Each `it` below names the site whose old rule it would have caught.
 */
import { describe, it, expect } from "vitest";
import { parseIssueNumberFromBranch, suggestBranchName, sanitizeBranchName } from "../src/lib/branch.js";

describe("parseIssueNumberFromBranch", () => {
  it("reads the number `suggestBranchName` wrote — the round trip that defines the format", () => {
    for (const n of [1, 7, 42, 539, 1024]) {
      expect(parseIssueNumberFromBranch(suggestBranchName({ issueNumber: n, title: "Some Title" }))).toBe(n);
    }
  });

  it("survives sanitization, where `/` becomes `_` (the reason `\\b` cannot be used)", () => {
    const sanitized = sanitizeBranchName(suggestBranchName({ issueNumber: 17, title: "x" })).replace(/\//g, "_");
    expect(sanitized).toContain("feature_ak-17");
    expect(parseIssueNumberFromBranch(sanitized)).toBe(17);
  });

  it.each([
    ["feature/ak-539-thing", 539],
    ["ak-539-thing", 539],
    ["ak-539", 539],
    ["feature_ak-539-thing", 539],
    ["Merge branch 'feature/ak-539-thing'", 539],
    ["C--projects-x--worktrees-feature-ak-539-thing", 539],
  ])("accepts %s", (name, expected) => {
    expect(parseIssueNumberFromBranch(name)).toBe(expected);
  });

  it("takes the FIRST occurrence, so a slug naming another issue cannot win (#146)", () => {
    expect(parseIssueNumberFromBranch("feature/ak-105-fix-ak-104-regression")).toBe(105);
  });

  it("rejects a bare leading number — `workspace-teardown` accepted this one", () => {
    // Old rule: /(?:^|[/_-])(?:ak-)?(\d+)-/ → `feature/2026-refresh` exported
    // KANBAN_ISSUE_NUMBER=2026 to every teardown script. A branch starting with a year is
    // not issue 2026.
    expect(parseIssueNumberFromBranch("feature/2026-refresh")).toBeNull();
    expect(parseIssueNumberFromBranch("123-hotfix")).toBeNull();
  });

  it("rejects `ak` glued to a preceding word — `hand-merged-branch-reconciler` accepted this one", () => {
    // Old rule: /(?:feature\/)?ak-(\d+)\b/ had no boundary BEFORE `ak`, so a merge subject
    // mentioning `weak-105` or `peak-3` force-Doned that issue number.
    expect(parseIssueNumberFromBranch("weak-105-x")).toBeNull();
    expect(parseIssueNumberFromBranch("Merge branch 'peak-3-tuning'")).toBeNull();
  });

  it("rejects digits glued to a following word", () => {
    expect(parseIssueNumberFromBranch("ak-105abc")).toBeNull();
  });

  it("requires the `ak-` marker at all", () => {
    expect(parseIssueNumberFromBranch("feature/no-number-here")).toBeNull();
    expect(parseIssueNumberFromBranch("master")).toBeNull();
  });

  it("is null-safe for an absent branch", () => {
    expect(parseIssueNumberFromBranch(null)).toBeNull();
    expect(parseIssueNumberFromBranch(undefined)).toBeNull();
    expect(parseIssueNumberFromBranch("")).toBeNull();
  });

  it("is case-insensitive, since branch names arrive sanitized to lower case but subjects do not", () => {
    expect(parseIssueNumberFromBranch("Feature/AK-539-Thing")).toBe(539);
  });
});
