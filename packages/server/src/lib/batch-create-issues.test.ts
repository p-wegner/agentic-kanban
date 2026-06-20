import { describe, it, expect } from "vitest";
import { normalizeBatchInput, validateBatchIssueInputs, formatBatchCreateResult } from "./batch-create-issues.js";

describe("normalizeBatchInput", () => {
  it("accepts a bare array of issues (no dependencies)", () => {
    expect(normalizeBatchInput([{ title: "A" }])).toEqual({ ok: true, issueInputs: [{ title: "A" }], dependencyInputs: [] });
  });

  it("accepts an { issues, dependencies } object", () => {
    const deps = [{ issueIndex: 0, dependsOnIndex: 1 }];
    expect(normalizeBatchInput({ issues: [{ title: "A" }, { title: "B" }], dependencies: deps }))
      .toEqual({ ok: true, issueInputs: [{ title: "A" }, { title: "B" }], dependencyInputs: deps });
  });

  it("defaults dependencies to [] when only issues present", () => {
    expect(normalizeBatchInput({ issues: [{ title: "A" }] }))
      .toEqual({ ok: true, issueInputs: [{ title: "A" }], dependencyInputs: [] });
  });

  it("rejects other shapes with the original error", () => {
    const err = { ok: false, error: "JSON must be an array of issues or an object with an 'issues' array." };
    expect(normalizeBatchInput({})).toEqual(err);
    expect(normalizeBatchInput({ issues: "nope" })).toEqual(err);
    expect(normalizeBatchInput(null)).toEqual(err);
    expect(normalizeBatchInput(42)).toEqual(err);
  });
});

describe("validateBatchIssueInputs", () => {
  const statuses = ["Backlog", "In Progress", "Done"];

  it("returns null when all issues are valid", () => {
    expect(validateBatchIssueInputs([{ title: "A" }, { title: "B", statusName: "Done" }], statuses)).toBeNull();
  });

  it("flags a missing/blank title with its index", () => {
    expect(validateBatchIssueInputs([{ title: "A" }, { title: "  " }], statuses)).toBe("issues[1].title is required.");
  });

  it("flags an unknown statusName and lists available ones in order", () => {
    expect(validateBatchIssueInputs([{ title: "A", statusName: "Nope" }], statuses))
      .toBe("issues[0].statusName 'Nope' not found. Available: Backlog, In Progress, Done");
  });

  it("checks title before statusName", () => {
    expect(validateBatchIssueInputs([{ title: "", statusName: "Nope" }], statuses)).toBe("issues[0].title is required.");
  });
});

describe("formatBatchCreateResult", () => {
  const created = [{ id: "id1", issueNumber: 10, title: "First" }, { id: "id2", issueNumber: 11, title: "Second" }];

  it("returns a single JSON line in json mode", () => {
    const lines = formatBatchCreateResult(created, 1, true);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ issues: created, dependenciesCreated: 1 });
  });

  it("renders the summary with the dependency suffix + per-issue lines", () => {
    expect(formatBatchCreateResult(created, 2, false)).toEqual([
      "Created 2 issue(s) with 2 dependency edge(s).",
      "  #10 First (id1)",
      "  #11 Second (id2)",
    ]);
  });

  it("omits the dependency suffix when none were created", () => {
    expect(formatBatchCreateResult([created[0]], 0, false)[0]).toBe("Created 1 issue(s).");
  });
});
