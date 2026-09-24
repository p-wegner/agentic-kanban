// @gate:always-run when:scripts/lib/repo-tree.mjs — imports the shared repo-tree walker from scripts/, outside every package's import graph (#1241).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import {
  REPO_TREE_SKIP_DIRS,
  isLinkedWorktreeDir,
  listRepoSubdirs,
  walkRepoTree,
} from "../../../scripts/lib/repo-tree.mjs";

/**
 * #1241 — the shared walker's three rules, proven on a planted tree rather than on this repo,
 * because on this repo the rules are only observable when a nested worktree happens to exist.
 *
 * The fixture: a root with an ordinary `packages/a/src` tree; a nested LINKED worktree
 * (`.claude/worktrees/agent1`, and a sibling `nested-wt/` whose only tell is that its `.git`
 * is a FILE); a `.worktrees/` sibling dir; a junction (`linked -> elsewhere`, `symlinkSync`
 * with type `junction` on Windows, `dir` elsewhere); and the canonical skip names.
 */
let root: string;
let elsewhere: string;
const rel = (abs: string): string => relative(root, abs).split(sep).join("/");

function plant(relPath: string, text = "x"): void {
  const abs = join(root, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ak-repo-tree-"));
  elsewhere = mkdtempSync(join(tmpdir(), "ak-repo-tree-elsewhere-"));
  plant("packages/a/src/index.ts");
  plant("packages/a/src/lib/util.ts");
  plant("packages/a/src/__tests__/util.test.ts");
  plant("packages/a/package.json", "{}");
  plant("scripts/tool.mjs");
  plant(".claude/hooks/guard.js");
  plant(".claude/settings.json", "{}");
  // A nested linked worktree in Claude Code's layout: skipped by NAME and by the .git-file rule.
  plant(".claude/worktrees/agent1/.git", "gitdir: /somewhere/.git/worktrees/agent1\n");
  plant(".claude/worktrees/agent1/packages/a/src/index.ts");
  // A linked worktree under an arbitrary name: only the .git-file rule can catch it.
  plant("nested-wt/.git", "gitdir: /somewhere/.git/worktrees/nested\n");
  plant("nested-wt/packages/a/src/index.ts");
  plant("nested-wt/package.json", "{}");
  // A REAL repo's `.git` is a directory — that is the canonical skip, not the worktree rule.
  plant(".git/HEAD", "ref: refs/heads/master\n");
  plant(".worktrees/feature-1/packages/a/src/index.ts");
  for (const name of ["node_modules", "dist", "build", "coverage", "target", ".turbo", ".vite", "test-results", "playwright-report"]) {
    plant(`${name}/inside.ts`);
  }
  // A junction/symlink to a tree OUTSIDE the root, holding a file that would otherwise be found.
  mkdirSync(join(elsewhere, "src"), { recursive: true });
  writeFileSync(join(elsewhere, "src", "escaped.ts"), "x");
  // (A FILE symlink is not planted: on Windows it needs a privilege a junction does not, and
  // the junction is the case that bites — plugin skills are junctioned into `.claude/skills/`.)
  symlinkSync(elsewhere, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  // A junction pointing back INSIDE the tree would otherwise double every file under it.
  symlinkSync(join(root, "packages"), join(root, "packages-link"), process.platform === "win32" ? "junction" : "dir");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

describe("walkRepoTree (#1241)", () => {
  it("skips a nested linked worktree (a directory whose .git is a FILE) wherever it sits", () => {
    const found = walkRepoTree(root, { includeDotfiles: true }).map(rel);
    expect(found).toContain("packages/a/src/index.ts");
    expect(found.filter((f) => f.startsWith(".claude/worktrees/"))).toEqual([]);
    expect(found.filter((f) => f.startsWith("nested-wt/"))).toEqual([]);
    expect(found.filter((f) => f.startsWith(".worktrees/"))).toEqual([]);
    // The canonical `.git` DIRECTORY is skipped as a name, so the rule never confuses the two.
    expect(found.filter((f) => f.startsWith(".git/"))).toEqual([]);
  });

  it("a walk ROOTED in a linked worktree still walks it — the root is exempt from the rule", () => {
    const nested = join(root, "nested-wt");
    expect(isLinkedWorktreeDir(nested)).toBe(true);
    expect(walkRepoTree(nested).map((f) => relative(nested, f).split(sep).join("/"))).toEqual([
      "package.json",
      "packages/a/src/index.ts",
    ]);
  });

  it("never follows a junction or symlink, whether it points inside or outside the tree", () => {
    const found = walkRepoTree(root, { includeDotfiles: true }).map(rel);
    expect(found.some((f) => f.startsWith("linked/"))).toBe(false);
    expect(found.some((f) => f.startsWith("packages-link/"))).toBe(false);
    expect(found).toContain("scripts/tool.mjs");
    expect(listRepoSubdirs(root).map(rel)).not.toContain("packages-link");
  });

  it("applies the canonical skip set, and `skipDirs` can only EXTEND it", () => {
    const found = walkRepoTree(root, { includeDotfiles: true, skipDirs: ["scripts"] }).map(rel);
    for (const name of REPO_TREE_SKIP_DIRS) {
      expect(found.some((f) => f.startsWith(`${name}/`)), `descended into ${name}/`).toBe(false);
    }
    expect(found.some((f) => f.startsWith("scripts/"))).toBe(false);
    expect(found).toContain("packages/a/src/index.ts");
  });

  it("hides dot-entries by default, admits them on request, and never filters the ROOT itself", () => {
    const plain = walkRepoTree(root).map(rel);
    expect(plain.some((f) => f.startsWith(".claude/"))).toBe(false);
    const withDots = walkRepoTree(root, { includeDotfiles: true }).map(rel);
    expect(withDots).toContain(".claude/hooks/guard.js");
    expect(withDots).toContain(".claude/settings.json");
    // Rooted AT a dot-directory: listed regardless of `includeDotfiles`.
    expect(walkRepoTree(join(root, ".claude", "hooks")).map(rel)).toEqual([".claude/hooks/guard.js"]);
  });

  it("honours `extensions`, `filter` and `maxDepth`, and yields a sorted list", () => {
    const ts = walkRepoTree(root, { extensions: [".ts"] }).map(rel);
    expect(ts).toEqual(["packages/a/src/__tests__/util.test.ts", "packages/a/src/index.ts", "packages/a/src/lib/util.ts"]);
    const noTests = walkRepoTree(root, { extensions: [".ts"], filter: (f) => !f.includes(".test.") }).map(rel);
    expect(noTests).toEqual(["packages/a/src/index.ts", "packages/a/src/lib/util.ts"]);
    expect(walkRepoTree(join(root, "packages", "a", "src"), { maxDepth: 0 }).map(rel)).toEqual(["packages/a/src/index.ts"]);
    expect(walkRepoTree(root, { skipDirs: ["__tests__"], extensions: [".ts"] }).map(rel)).toEqual([
      "packages/a/src/index.ts",
      "packages/a/src/lib/util.ts",
    ]);
  });

  it("returns [] for a missing root rather than throwing", () => {
    expect(walkRepoTree(join(root, "does-not-exist"))).toEqual([]);
  });
});

describe("listRepoSubdirs (#1241)", () => {
  it("lists one level of descendable directories with the same rules", () => {
    const dirs = listRepoSubdirs(root, { includeDotfiles: true }).map(rel);
    expect(dirs).toEqual([".claude", "packages", "scripts"]);
    expect(listRepoSubdirs(root).map(rel)).toEqual(["packages", "scripts"]);
    expect(listRepoSubdirs(join(root, ".claude")).map(rel)).toEqual([".claude/hooks"]);
  });
});
