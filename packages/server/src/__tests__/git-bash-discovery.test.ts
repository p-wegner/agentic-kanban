import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../services/process-exec.js", () => ({
  execCommand: vi.fn(async () => ({ stdout: "", stderr: "" })),
  execShellCommand: vi.fn(async () => ({ stdout: "", stderr: "" })),
}));

import { findGitBash, runScript, describeGitBash, NO_GIT_BASH_MESSAGE } from "../services/script-runner.js";
import { execCommand, execShellCommand } from "../services/process-exec.js";

describe("findGitBash next to the git on PATH (#1716)", () => {
  const root = join("C:", "Users", "x", "scoop", "apps", "git", "2.50");
  const gitDir = join(root, "cmd");

  it("finds <root>\\bin\\bash.exe for a scoop git", () => {
    const files = new Set([join(gitDir, "git.exe"), join(root, "bin", "bash.exe")]);
    expect(findGitBash({ PATH: `C:\\other;${gitDir}` }, (p) => files.has(p))).toBe(join(root, "bin", "bash.exe"));
  });

  it("falls back to <root>\\usr\\bin\\bash.exe", () => {
    const files = new Set([join(gitDir, "git.exe"), join(root, "usr", "bin", "bash.exe")]);
    expect(findGitBash({ PATH: gitDir }, (p) => files.has(p))).toBe(join(root, "usr", "bin", "bash.exe"));
  });

  it("keeps KANBAN_GIT_BASH first", () => {
    const files = new Set(["D:/bash.exe", join(gitDir, "git.exe"), join(root, "bin", "bash.exe")]);
    expect(findGitBash({ KANBAN_GIT_BASH: "D:/bash.exe", PATH: gitDir }, (p) => files.has(p))).toBe("D:/bash.exe");
  });

  it("describeGitBash names the path or its absence", () => {
    expect(describeGitBash("win32", "C:/b/bash.exe")).toContain("C:/b/bash.exe");
    expect(describeGitBash("win32", null)).toContain("NOT FOUND");
  });
});

describe("runScript posix without Git Bash (#1716)", () => {
  it("fails with the named message and never uses cmd.exe", async () => {
    const r = await runScript("rm -rf x", process.cwd(), "t", {}, { posix: true, platform: "win32", gitBash: null });
    expect(r.ok).toBe(false);
    expect(r.output).toBe(NO_GIT_BASH_MESSAGE);
    expect(execShellCommand).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
  });
});

describe("merge-workflow teardown shell", () => {
  it("passes posix: true", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "startup", "merge-workflow.ts"), "utf8");
    expect(src).toMatch(/runScript\(teardownScript,[^;]*\{ posix: true \}/);
  });
});
