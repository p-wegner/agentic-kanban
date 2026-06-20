import { describe, expect, it } from "vitest";
import {
  parseUnifiedDiff,
  computeFileStats,
  buildFileTree,
  commentKey,
  buildCommentMap,
  computeCollapsibleRegions,
  type DiffLine,
} from "./diff-parse.js";
import type { DiffComment } from "@agentic-kanban/shared";

const SAMPLE = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " context one",
  "-removed line",
  "+added line",
  " context two",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("parses files, hunks, and add/delete/context lines with line numbers", () => {
    const files = parseUnifiedDiff(SAMPLE);
    expect(files).toHaveLength(1);
    expect(files[0].filePath).toBe("src/a.ts");
    const types = files[0].lines.map((l) => l.type);
    expect(types).toEqual(["hunk", "context", "delete", "add", "context"]);
    const del = files[0].lines.find((l) => l.type === "delete")!;
    const add = files[0].lines.find((l) => l.type === "add")!;
    expect(del.lineNumOld).toBe(2);
    expect(add.lineNumNew).toBe(2);
  });

  it("ignores /dev/null target headers", () => {
    const files = parseUnifiedDiff("--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone");
    expect(files).toHaveLength(0);
  });
});

describe("computeFileStats", () => {
  it("counts additions and deletions", () => {
    const lines = parseUnifiedDiff(SAMPLE)[0].lines;
    expect(computeFileStats(lines)).toEqual({ additions: 1, deletions: 1 });
  });
});

describe("buildFileTree", () => {
  it("nests files under directory nodes and rolls up stats", () => {
    const files = [
      { filePath: "src/a.ts", lines: parseUnifiedDiff(SAMPLE)[0].lines },
      { filePath: "src/sub/b.ts", lines: [] as DiffLine[] },
    ];
    const tree = buildFileTree(files);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("src");
    expect(tree[0].isFile).toBe(false);
    const names = tree[0].children.map((c) => c.name).sort();
    expect(names).toEqual(["a.ts", "sub"]);
  });
});

describe("commentKey / buildCommentMap", () => {
  it("builds a stable key and groups comments by it", () => {
    expect(commentKey("f.ts", 1, null, "old")).toBe("f.ts:1::old");
    const comments = [
      { filePath: "f.ts", lineNumOld: 1, lineNumNew: null, side: "old" },
      { filePath: "f.ts", lineNumOld: 1, lineNumNew: null, side: "old" },
      { filePath: "f.ts", lineNumOld: 2, lineNumNew: null, side: "old" },
    ] as unknown as DiffComment[];
    const map = buildCommentMap(comments);
    expect(map.get("f.ts:1::old")).toHaveLength(2);
    expect(map.get("f.ts:2::old")).toHaveLength(1);
  });
});

describe("computeCollapsibleRegions", () => {
  it("collapses runs of more than 2*CONTEXT_LINES context lines", () => {
    const ctx = (n: number): DiffLine[] => Array.from({ length: n }, () => ({ type: "context", content: "x" }));
    expect(computeCollapsibleRegions(ctx(6))).toEqual([]); // exactly 2*3, not collapsed
    const regions = computeCollapsibleRegions(ctx(10));
    expect(regions).toHaveLength(1);
    expect(regions[0]).toEqual({ startIdx: 3, endIdx: 7, collapsedCount: 4 });
  });
});
