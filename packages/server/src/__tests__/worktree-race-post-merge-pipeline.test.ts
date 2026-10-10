// #1353 — the worktree race survived #1339 (per-repo lock) and #1342 (--expire prune). Those two
// tickets were verified with unit tests that call removeWorktree/pruneWorktrees directly; the
// incident came through the REAL post-merge pipeline (merge -> cleanupMergedWorktreeAndBranch ->
// removeWorktree + deleteBranch) overlapping a new workspace's worktree-setup. This drives that
// pipeline, on real git, while other workspaces provision, and checks the admin-op log.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createTestDb } from "./helpers/test-db.js";
import { cleanupMergedWorktreeAndBranch } from "../services/merge-executor.service.js";
import * as gitService from "../services/git.service.js";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolvePromise(stdout.toString());
    });
  });
}

describe("post-merge cleanup pipeline vs a concurrently provisioning workspace (#1353)", () => {
  let repo: string;
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(async () => {
    const parent = await mkdtemp(join(tmpdir(), "ak-wt-pipeline-"));
    repo = join(parent, "app");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init"]);
    await writeFile(join(repo, "app.txt"), "marker\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "initial commit"]);
    await git(repo, ["branch", "-M", "main"]);
    logSpy = vi.spyOn(console, "log");
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  /** Create A's worktree, commit on it, and merge it into main — the state at merge time. */
  async function mergedWorkspace(n: number): Promise<{ branch: string; path: string }> {
    const branch = `feature/ak-${n}-merged`;
    const path = await gitService.createWorktree(repo, branch, "main");
    await writeFile(join(path, `file-${n}.txt`), `work ${n}\n`);
    await git(path, ["add", "-A"]);
    await git(path, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", `work ${n}`]);
    await git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "--no-ff", "-m", `merge ${n}`, branch]);
    return { branch, path };
  }

  it("keeps every provisioning worktree registered and checked out across repeated merge cleanups", async () => {
    const { db } = createTestDb();
    for (let round = 0; round < 3; round++) {
      const merged = await mergedWorkspace(100 + round);
      const events: string[] = [];

      const cleanup = cleanupMergedWorktreeAndBranch({
        repoPath: repo,
        workingDir: merged.path,
        branch: merged.branch,
        gitService,
        database: db,
        onBranchDeleted: () => { events.push("branch-deleted"); },
        onRemoveWorktreeError: (e) => { events.push(`remove-error:${String(e)}`); },
        onDeleteBranchError: (e) => { events.push(`delete-error:${String(e)}`); },
      });
      const provisioning = [200 + round * 2, 201 + round * 2].map((n) =>
        gitService.createWorktree(repo, `feature/ak-${n}-new`, "main"));
      const [, ...created] = await Promise.all([cleanup, ...provisioning]);

      expect(events).toEqual(["branch-deleted"]);
      expect(existsSync(merged.path)).toBe(false);
      const registered = (await gitService.listWorktrees(repo)).map((w) => resolve(w.path).toLowerCase());
      for (const p of created as string[]) {
        expect(registered).toContain(resolve(p).toLowerCase());
        expect(existsSync(join(p, ".git"))).toBe(true);
        expect((await git(p, ["status", "--porcelain"])).trim()).toBe("");
      }
    }
  });

  it("a half-provisioned sibling (registered, no .git yet) survives the whole pipeline", async () => {
    const { db } = createTestDb();
    const inFlight = await gitService.createWorktree(repo, "feature/ak-300-inflight", "main");
    await rm(join(inFlight, ".git"), { force: true }); // the `worktree add` window
    const merged = await mergedWorkspace(301);

    await cleanupMergedWorktreeAndBranch({
      repoPath: repo, workingDir: merged.path, branch: merged.branch, gitService, database: db,
    });

    const registered = (await gitService.listWorktrees(repo)).map((w) => resolve(w.path).toLowerCase());
    expect(registered).toContain(resolve(inFlight).toLowerCase());
  });

  it("every prune the pipeline runs is age-bounded and runs under the admin lock", async () => {
    const { db } = createTestDb();
    const merged = await mergedWorkspace(400);
    await Promise.all([
      cleanupMergedWorktreeAndBranch({
        repoPath: repo, workingDir: merged.path, branch: merged.branch, gitService, database: db,
      }),
      gitService.createWorktree(repo, "feature/ak-401-new", "main"),
    ]);

    const lines = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[worktree-admin] start "));
    expect(lines.some((l) => l.includes("op=add"))).toBe(true);
    expect(lines.some((l) => l.includes("op=remove"))).toBe(true);
    for (const l of lines) expect(l).toContain("lock=yes");
    for (const l of lines.filter((x) => x.includes("op=prune"))) expect(l).toContain("--expire=");
  });
});
