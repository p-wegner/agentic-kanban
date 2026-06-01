import { describe, it, expect } from "vitest";
import { isValidDirName, parseSymlinkDirs } from "@agentic-kanban/shared/lib/worktree-symlink-bootstrap";

describe("isValidDirName", () => {
  it("accepts normal directory names", () => {
    expect(isValidDirName("node_modules")).toBe(true);
    expect(isValidDirName(".venv")).toBe(true);
    expect(isValidDirName("dist")).toBe(true);
    expect(isValidDirName("my-deps")).toBe(true);
    expect(isValidDirName("deps.v2")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidDirName("")).toBe(false);
  });

  it("rejects path traversal attempts", () => {
    expect(isValidDirName("..")).toBe(false);
    expect(isValidDirName(".")).toBe(false);
    expect(isValidDirName("../etc")).toBe(false);
    expect(isValidDirName("..\\etc")).toBe(false);
  });

  it("rejects paths with separators", () => {
    expect(isValidDirName("sub/dir")).toBe(false);
    expect(isValidDirName("sub\\dir")).toBe(false);
    expect(isValidDirName("/absolute")).toBe(false);
    expect(isValidDirName("C:\\path")).toBe(false);
  });
});

describe("parseSymlinkDirs", () => {
  it("returns empty for null/undefined/empty", () => {
    expect(parseSymlinkDirs(null)).toEqual([]);
    expect(parseSymlinkDirs(undefined)).toEqual([]);
    expect(parseSymlinkDirs("")).toEqual([]);
  });

  it("parses a valid JSON array of strings", () => {
    expect(parseSymlinkDirs('["node_modules",".venv"]')).toEqual(["node_modules", ".venv"]);
  });

  it("filters out non-string entries", () => {
    expect(parseSymlinkDirs('["node_modules", 42, true, null]')).toEqual(["node_modules"]);
  });

  it("filters out invalid directory names (path traversal)", () => {
    expect(parseSymlinkDirs('["node_modules","..","sub/dir"]')).toEqual(["node_modules"]);
  });

  it("returns empty for invalid JSON", () => {
    expect(parseSymlinkDirs("not json")).toEqual([]);
    expect(parseSymlinkDirs("{")).toEqual([]);
  });

  it("returns empty for non-array JSON", () => {
    expect(parseSymlinkDirs('"node_modules"')).toEqual([]);
    expect(parseSymlinkDirs("42")).toEqual([]);
    expect(parseSymlinkDirs("{}")).toEqual([]);
  });
});
