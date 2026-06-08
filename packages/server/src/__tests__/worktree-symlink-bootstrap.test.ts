import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isValidDirName,
  parseSymlinkDirs,
  discoverWorkspaceNodeModules,
} from "@agentic-kanban/shared/lib/worktree-symlink-bootstrap";

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

describe("discoverWorkspaceNodeModules", () => {
  function makeWorkspace(opts: { workspaceYaml?: string; pkgs?: string[]; withNodeModules?: string[] }): string {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    if (opts.workspaceYaml !== undefined) writeFileSync(join(root, "pnpm-workspace.yaml"), opts.workspaceYaml);
    for (const p of opts.pkgs ?? []) mkdirSync(join(root, p), { recursive: true });
    for (const p of opts.withNodeModules ?? []) mkdirSync(join(root, p, "node_modules"), { recursive: true });
    return root;
  }

  it("returns [] when there is no pnpm-workspace.yaml", () => {
    const root = makeWorkspace({ pkgs: ["packages/server"], withNodeModules: ["packages/server"] });
    expect(discoverWorkspaceNodeModules(root)).toEqual([]);
  });

  it("expands a packages/* glob to each package's node_modules that exists", () => {
    const root = makeWorkspace({
      workspaceYaml: 'packages:\n  - "packages/*"\n',
      pkgs: ["packages/server", "packages/shared", "packages/no-deps"],
      withNodeModules: ["packages/server", "packages/shared"], // no-deps has none
    });
    const got = discoverWorkspaceNodeModules(root).sort();
    expect(got).toEqual(["packages/server/node_modules", "packages/shared/node_modules"]);
  });

  it("supports literal (non-glob) package paths", () => {
    const root = makeWorkspace({
      workspaceYaml: "packages:\n  - packages/server\n",
      withNodeModules: ["packages/server"],
    });
    expect(discoverWorkspaceNodeModules(root)).toEqual(["packages/server/node_modules"]);
  });

  it("ignores traversal/absolute patterns", () => {
    const root = makeWorkspace({ workspaceYaml: 'packages:\n  - "../evil/*"\n  - "/abs/*"\n' });
    expect(discoverWorkspaceNodeModules(root)).toEqual([]);
  });
});
