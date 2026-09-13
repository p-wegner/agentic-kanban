// @gate:always-run when:scripts/prune-worktree-husks.mjs,scripts/safe-rmdir.mjs — imports scripts/prune-worktree-husks.mjs, a script under `scripts/` that no import graph reaches (#1033/#1126).
/**
 * #1126 — a worktree directory that `git worktree remove` failed to fully tear down keeps its
 * (untracked) `node_modules` on disk, holding pnpm-store hard links open forever. A dir is a
 * HUSK only when it is claimed by NEITHER `git worktree list` NOR a `workspaces.working_dir`
 * row — this pins that set-difference, plus the two "claimed" readers around it.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findHuskDirs,
  getLiveWorktreePaths,
  getWorkspaceWorkingDirs,
  listCandidateDirs,
} from "../../../../scripts/prune-worktree-husks.mjs";

describe("findHuskDirs (#1126)", () => {
  it("is empty when every candidate is claimed by a live worktree or a workspace row", () => {
    const husks = findHuskDirs(["/w/live", "/w/claimed", "/w/husk"], ["/w/live"], ["/w/claimed"]);
    expect(husks).toEqual(["/w/husk"]);
  });

  it("normalizes case/trailing separators (Windows paths) before comparing", () => {
    const husks = findHuskDirs(["C:/w/ak-1"], ["c:\\w\\ak-1\\"], []);
    expect(husks).toEqual([]);
  });

  it("returns every candidate when neither set claims any of them", () => {
    const husks = findHuskDirs(["/w/a", "/w/b"], [], []);
    expect(husks).toEqual(["/w/a", "/w/b"]);
  });
});

describe("listCandidateDirs (#1126)", () => {
  it("lists directories directly under the worktrees root, and returns [] when absent", () => {
    const root = mkdtempSync(join(tmpdir(), "ak-husks-"));
    try {
      mkdirSync(join(root, "ak-1"));
      mkdirSync(join(root, "ak-2"));
      const dirs = listCandidateDirs(root).map((d) => d.split(/[\\/]/).pop());
      expect(dirs.sort()).toEqual(["ak-1", "ak-2"]);
      expect(listCandidateDirs(join(root, "missing"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("getWorkspaceWorkingDirs (#1126)", () => {
  it("reads non-null working_dir values from a workspaces table", () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-husks-db-"));
    const dbPath = join(dir, "kanban.db");
    try {
      const db = new DatabaseSync(dbPath);
      db.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY, working_dir TEXT)");
      db.prepare("INSERT INTO workspaces (id, working_dir) VALUES (?, ?)").run("1", "/w/ak-1");
      db.prepare("INSERT INTO workspaces (id, working_dir) VALUES (?, ?)").run("2", null);
      db.close();

      const dirs = getWorkspaceWorkingDirs(dbPath);
      expect(dirs).toHaveLength(1);
      expect(dirs[0].replace(/\\/g, "/")).toMatch(/\/w\/ak-1$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] when the db file does not exist", () => {
    expect(getWorkspaceWorkingDirs(join(tmpdir(), "ak-does-not-exist", "kanban.db"))).toEqual([]);
  });
});

describe("getLiveWorktreePaths (#1126)", () => {
  it("lists the repo's own path from `git worktree list --porcelain`", () => {
    const repo = mkdtempSync(join(tmpdir(), "ak-husks-repo-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
      execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: repo });

      const paths = getLiveWorktreePaths(repo);
      expect(paths.some((p) => existsSync(p) && p.toLowerCase().includes(repo.toLowerCase().split(/[\\/]/).pop()))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
