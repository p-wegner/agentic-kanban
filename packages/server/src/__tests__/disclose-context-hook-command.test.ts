// @gate:always-run when:.claude/settings.json,.claude/hooks/**,packages/server/src/scaffold/**,packages/server/src/services/project-scaffold.ts
// It spawns disclose-context.mjs as a real subprocess from a fixture directory tree outside
// this file's own import graph, so a scoped run would never see what it exercises — but the
// territory it reads is exactly the wired hook command and the scaffold that ships it, so it
// carries a `when:` precondition (#1041) rather than ~3s on every gate that cannot narrow.
// #1069: the disclose-context.mjs PostToolUse hook was wired as a bare relative path
// (`node .claude/hooks/disclose-context.mjs`). Node resolves that argument against the
// spawned process's ACTUAL OS cwd — which mirrors wherever the triggering Bash call last
// `cd`'d to, not the worktree root — so the very first Bash call after a `cd` into a
// subdirectory made every later Bash/PowerShell/Grep/Glob call in the session fail with a
// non-blocking MODULE_NOT_FOUND. These tests spawn the exact wired command from a
// subdirectory to prove the regression and prove the fix, rather than trusting the string.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISCLOSE_CONTEXT_COMMAND } from "../services/project-scaffold.js";

const SCAFFOLD_SOURCE = join(import.meta.dirname!, "..", "scaffold", "disclose-context.mjs");

function makeFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ak-disclose-cwd-"));
  mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
  mkdirSync(join(root, "sub", "deeper"), { recursive: true });
  writeFileSync(join(root, ".git"), ""); // a `.git` marker is enough for the walk-up to find root
  const source = readFileSync(SCAFFOLD_SOURCE, "utf8");
  writeFileSync(join(root, ".claude", "hooks", "disclose-context.mjs"), source);
  return root;
}

function runHookCommand(command: string, cwd: string): { status: number | null; stderr: string } {
  const result = spawnSync(command, {
    cwd,
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo hi" }, cwd }),
    shell: true,
    encoding: "utf8",
    timeout: 10_000,
  });
  return { status: result.status, stderr: result.stderr ?? "" };
}

describe("disclose-context hook command survives a drifted cwd (#1069)", () => {
  it("reproduces the original bug: a bare relative path MODULE_NOT_FOUNDs once cwd drifts off the worktree root", () => {
    const root = makeFixtureRepo();
    try {
      const drifted = join(root, "sub", "deeper");
      const { status, stderr } = runHookCommand("node .claude/hooks/disclose-context.mjs", drifted);
      expect(status).not.toBe(0);
      expect(stderr).toContain("MODULE_NOT_FOUND");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the canonical DISCLOSE_CONTEXT_COMMAND exits 0 from a drifted cwd", () => {
    const root = makeFixtureRepo();
    try {
      const drifted = join(root, "sub", "deeper");
      const { status, stderr } = runHookCommand(DISCLOSE_CONTEXT_COMMAND, drifted);
      expect(stderr).not.toContain("MODULE_NOT_FOUND");
      expect(status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the canonical DISCLOSE_CONTEXT_COMMAND still exits 0 from the worktree root itself", () => {
    const root = makeFixtureRepo();
    try {
      const { status, stderr } = runHookCommand(DISCLOSE_CONTEXT_COMMAND, root);
      expect(stderr).not.toContain("MODULE_NOT_FOUND");
      expect(status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the fixture actually copied a real, loadable disclose-context.mjs (sanity check on the test itself)", () => {
    const root = makeFixtureRepo();
    try {
      expect(existsSync(join(root, ".claude", "hooks", "disclose-context.mjs"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
