// @gate:always-run when:.claude/skills/**,.codex/skills/**,scripts/skills-mirror.mjs — drives a throwaway git repo through the mirror script (#1576).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain .mjs script
import { checkIndex, syncWorktree, findDrift } from "../../../../scripts/skills-mirror.mjs";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
function put(cwd: string, rel: string, body: string) {
  mkdirSync(join(cwd, rel, ".."), { recursive: true });
  writeFileSync(join(cwd, rel), body);
}

describe("skills-mirror (#1576)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "skills-mirror-"));
    git(repo, "init", "-q");
    put(repo, ".claude/skills/a/SKILL.md", "one\n");
    put(repo, ".codex/skills/a/SKILL.md", "one\n");
    git(repo, "add", "-A");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("passes when both trees match", () => {
    expect(checkIndex(repo)).toEqual([]);
  });

  it("catches a staged .claude/skills change without its mirror", () => {
    put(repo, ".claude/skills/a/SKILL.md", "two\n");
    git(repo, "add", "-A");
    expect(checkIndex(repo)).toEqual(["a/SKILL.md"]);
  });

  it("sync copies, deletes orphans, stages, and then the check passes", () => {
    put(repo, ".claude/skills/a/SKILL.md", "two\n");
    put(repo, ".claude/skills/b/SKILL.md", "new\n");
    git(repo, "add", "-A");
    syncWorktree(repo);
    expect(checkIndex(repo)).toEqual([]);
  });

  it("ignores CRLF-only differences", () => {
    expect(findDrift(new Map([["x", "1"]]), new Map([["x", "2"]]), (h: string) => (h === "1" ? "a\r\nb" : "a\nb"))).toEqual([]);
  });
});
