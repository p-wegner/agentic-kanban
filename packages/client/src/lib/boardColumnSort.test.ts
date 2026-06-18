import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  loadSortMode,
  saveSortMode,
  nextSortMode,
  sortColumnIssues,
  sortModeStorageKey,
  VALID_SORT_MODES,
} from "./boardColumnSort.js";

function mkIssue(id: string, issueType?: string) {
  // Only the fields the comparator reads matter; cast through unknown to keep
  // the test focused on sort behavior rather than the full IssueWithStatus shape.
  return { id, issueType } as unknown as Parameters<typeof sortColumnIssues>[0][number];
}

describe("sortModeStorageKey", () => {
  it("namespaces by column id", () => {
    expect(sortModeStorageKey("col-123")).toBe("col-sort-col-123");
  });
});

describe("nextSortMode", () => {
  it("toggles default → type", () => {
    expect(nextSortMode("default")).toBe("type");
  });
  it("toggles type → default", () => {
    expect(nextSortMode("type")).toBe("default");
  });
});

describe("VALID_SORT_MODES", () => {
  it("accepts the two supported modes and rejects others", () => {
    expect(VALID_SORT_MODES.has("default")).toBe(true);
    expect(VALID_SORT_MODES.has("type")).toBe(true);
    expect(VALID_SORT_MODES.has("priority")).toBe(false);
  });
});

describe("loadSortMode / saveSortMode", () => {
  // The test environment is node (no DOM), so stub a minimal in-memory
  // localStorage the way the rest of the lib tests do.
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to 'default' when nothing is stored", () => {
    expect(loadSortMode("c1")).toBe("default");
  });

  it("round-trips a saved mode", () => {
    saveSortMode("c1", "type");
    expect(loadSortMode("c1")).toBe("type");
  });

  it("ignores an invalid stored value and falls back to 'default'", () => {
    localStorage.setItem(sortModeStorageKey("c1"), "bogus");
    expect(loadSortMode("c1")).toBe("default");
  });

  it("scopes modes per column", () => {
    saveSortMode("c1", "type");
    expect(loadSortMode("c2")).toBe("default");
  });
});

describe("sortColumnIssues", () => {
  it("returns the input untouched in default mode", () => {
    const issues = [mkIssue("a", "task"), mkIssue("b", "bug")];
    const result = sortColumnIssues(issues, "default");
    expect(result).toBe(issues); // same reference — no copy in default mode
  });

  it("orders by issue type (bug < feature < task < chore) in type mode", () => {
    const issues = [
      mkIssue("chore", "chore"),
      mkIssue("task", "task"),
      mkIssue("bug", "bug"),
      mkIssue("feature", "feature"),
    ];
    const result = sortColumnIssues(issues, "type");
    expect(result.map((i) => i.id)).toEqual(["bug", "feature", "task", "chore"]);
  });

  it("treats a missing/unknown issue type as 'task' in type mode", () => {
    const issues = [mkIssue("bug", "bug"), mkIssue("untyped"), mkIssue("chore", "chore")];
    const result = sortColumnIssues(issues, "type");
    expect(result.map((i) => i.id)).toEqual(["bug", "untyped", "chore"]);
  });

  it("does not mutate the input array in type mode", () => {
    const issues = [mkIssue("chore", "chore"), mkIssue("bug", "bug")];
    sortColumnIssues(issues, "type");
    expect(issues.map((i) => i.id)).toEqual(["chore", "bug"]);
  });
});
