// @covers git.workingTreeChanges.untracked [boundary, error-handling]
//
// #469: distinguishing "the agent did nothing" from "the agent did the work and never committed
// it". The board's session-exit path treated both as the same silent no-op, so three sessions in
// one day produced correct, complete work, committed none of it, and were recorded as finished —
// two of them with exit code 0.
//
// The distinguishing signal is a dirty worktree, and it MUST count untracked files: lost work is
// very often mostly NEW files (a decomposition that extracts 14 modules is almost entirely `??`),
// which is exactly what `getUncommittedTrackedChanges` filters out.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getUncommittedTrackedChanges, getWorkingTreeChanges } from "../src/lib/git-service.js";

const GIT_IO_TIMEOUT_MS = Number(process.env.VITEST_GIT_IO_TIMEOUT) || 120_000;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.toString());
    });
  });
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ak-wt-changes-"));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "README.md"), "# seed\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "seed"]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("getWorkingTreeChanges (#469)", () => {
  it("reports nothing for a clean tree — the 'agent genuinely did nothing' case", { timeout: GIT_IO_TIMEOUT_MS }, async () => {
    expect(await getWorkingTreeChanges(root)).toEqual([]);
  });

  it("sees UNCOMMITTED NEW files, which the tracked-only reader misses", { timeout: GIT_IO_TIMEOUT_MS }, async () => {
    await writeFile(join(root, "extracted-module.ts"), "export const x = 1;\n");

    // The whole reason this function exists: the merge-safety reader is blind here, because an
    // untracked file does not block `git merge`. For lost-work detection it is the evidence.
    expect(await getUncommittedTrackedChanges(root)).toEqual([]);

    const changes = await getWorkingTreeChanges(root);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain("extracted-module.ts");
  });

  it("sees modifications to tracked files too", { timeout: GIT_IO_TIMEOUT_MS }, async () => {
    await writeFile(join(root, "README.md"), "# edited\n");
    const changes = await getWorkingTreeChanges(root);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain("README.md");
  });

  it("counts a mixed dirty tree — the real shape of an uncommitted refactor", { timeout: GIT_IO_TIMEOUT_MS }, async () => {
    await writeFile(join(root, "README.md"), "# edited\n");
    await writeFile(join(root, "new-a.ts"), "export const a = 1;\n");
    await writeFile(join(root, "new-b.ts"), "export const b = 2;\n");
    expect(await getWorkingTreeChanges(root)).toHaveLength(3);
  });

  it("returns [] rather than throwing for a path that is not a repo", { timeout: GIT_IO_TIMEOUT_MS }, async () => {
    // The caller is an error path in the exit workflow; it must never be the thing that throws.
    const notARepo = await mkdtemp(join(tmpdir(), "ak-not-a-repo-"));
    try {
      expect(await getWorkingTreeChanges(notARepo)).toEqual([]);
    } finally {
      await rm(notARepo, { recursive: true, force: true }).catch(() => {});
    }
  });
});
