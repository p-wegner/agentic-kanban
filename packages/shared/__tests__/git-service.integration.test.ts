import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectConflicts,
  ensureOnBranch,
  getCurrentBranch,
  getWorkingTreeDiff,
  mergeBranch,
  revParse,
  syncBranchToHead,
} from "../src/lib/git-service.js";

interface TempRepo {
  root: string;
  origin: string;
  repo: string;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(stdout.toString());
    });
  });
}

async function createRepo(): Promise<TempRepo> {
  const root = await mkdtemp(join(tmpdir(), "ak-git-service-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const repo = join(root, "repo");

  await git(root, ["init", "--bare", origin]);
  await git(root, ["clone", origin, seed]);
  await configureUser(seed);
  await writeFile(join(seed, "README.md"), "# Test\n");
  await git(seed, ["add", "."]);
  await git(seed, ["commit", "-m", "initial commit"]);
  await git(seed, ["branch", "-M", "main"]);
  await git(seed, ["push", "-u", "origin", "main"]);
  await git(root, ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"]);

  await git(root, ["clone", origin, repo]);
  await configureUser(repo);

  expect((await git(root, ["--git-dir", origin, "rev-parse", "--is-bare-repository"])).trim()).toBe("true");

  return { root, origin, repo };
}

async function configureUser(repo: string): Promise<void> {
  await git(repo, ["config", "user.email", "test@example.local"]);
  await git(repo, ["config", "user.name", "Git Service Test"]);
}

async function writeRepoFile(repo: string, relativePath: string, content: string): Promise<void> {
  const filePath = join(repo, ...relativePath.split("/"));
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function commitFiles(
  repo: string,
  branch: string,
  files: Record<string, string>,
  message: string,
  startPoint?: string,
): Promise<string> {
  if (startPoint) {
    await git(repo, ["checkout", "-B", branch, startPoint]);
  } else {
    await git(repo, ["checkout", "-B", branch]);
  }
  for (const [relativePath, content] of Object.entries(files)) {
    await writeRepoFile(repo, relativePath, content);
  }
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", message]);
  return revParse(repo, "HEAD");
}

async function seedCommittedFile(repo: string, relativePath: string, content: string, message: string): Promise<string> {
  await git(repo, ["checkout", "main"]);
  await writeRepoFile(repo, relativePath, content);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", message]);
  return revParse(repo, "HEAD");
}

async function fileContent(repo: string, relativePath: string): Promise<string> {
  return readFile(join(repo, ...relativePath.split("/")), "utf-8");
}

function trimmedContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

describe("git-service integration", () => {
  let temp: TempRepo;

  beforeEach(async () => {
    temp = await createRepo();
  }, 30000);

  afterEach(async () => {
    await rm(temp.root, { recursive: true, force: true });
  });

  it("mergeBranch creates a clean plumbing merge and syncs the checked-out target", async () => {
    await commitFiles(
      temp.repo,
      "feature/clean-merge",
      { "clean.txt": "clean branch\n" },
      "add clean file",
      "main",
    );
    await git(temp.repo, ["checkout", "main"]);

    const result = await mergeBranch(temp.repo, "feature/clean-merge", "main");

    expect(result).toContain("plumbing-merge");
    expect((await fileContent(temp.repo, "clean.txt")).trim()).toBe("clean branch");
    expect((await git(temp.repo, ["show", "main:clean.txt"])).trim()).toBe("clean branch");
    expect((await git(temp.repo, ["status", "--porcelain"])).trim()).toBe("");
  }, 30000);

  it("mergeBranch rejects conflicts without committing conflict markers", async () => {
    await seedCommittedFile(
      temp.repo,
      "shared-conflict.txt",
      "line 1\nbase line\nline 3\n",
      "seed conflict file",
    );
    const branchBase = await revParse(temp.repo, "main");

    await commitFiles(
      temp.repo,
      "feature/conflict-a",
      { "shared-conflict.txt": "line 1\nbranch A edit\nline 3\n" },
      "branch A edit",
      branchBase,
    );
    await git(temp.repo, ["checkout", "main"]);
    await mergeBranch(temp.repo, "feature/conflict-a", "main");
    const mainAfterA = await revParse(temp.repo, "main");

    await commitFiles(
      temp.repo,
      "feature/conflict-b",
      { "shared-conflict.txt": "line 1\nbranch B edit\nline 3\n" },
      "branch B edit",
      branchBase,
    );
    await git(temp.repo, ["checkout", "main"]);

    await expect(mergeBranch(temp.repo, "feature/conflict-b", "main")).rejects.toThrow(/conflict/i);

    expect(await revParse(temp.repo, "main")).toBe(mainAfterA);
    expect(existsSync(join(temp.repo, ".git", "MERGE_HEAD"))).toBe(false);

    const workingTreeContent = await fileContent(temp.repo, "shared-conflict.txt");
    expect(trimmedContent(workingTreeContent)).toBe("line 1\nbranch A edit\nline 3");
    expect(workingTreeContent).not.toContain("<<<<<<<");
    expect(workingTreeContent).not.toContain("=======");
    expect(workingTreeContent).not.toContain(">>>>>>>");

    const mainCommits = (await git(temp.repo, ["rev-list", "main"])).trim().split("\n").filter(Boolean);
    for (const sha of mainCommits) {
      let historicalContent = "";
      try {
        historicalContent = await git(temp.repo, ["show", `${sha}:shared-conflict.txt`]);
      } catch {
        continue;
      }
      expect(historicalContent).not.toContain("<<<<<<<");
      expect(historicalContent).not.toContain("=======");
      expect(historicalContent).not.toContain(">>>>>>>");
    }
  }, 30000);

  it("mergeBranch self-heals a desynced checkout, never leaving tracked files deleted (#692)", async () => {
    // Regression for #692: a failed/interrupted merge attempt left the main checkout
    // with packages/shared/drizzle/* (and friends) showing as DELETED in the working
    // tree while HEAD still referenced them — the monitor had to `git restore` them
    // from HEAD before the server would start. mergeBranch's working-tree sync must
    // never leave tracked files deleted relative to HEAD.
    const sharedFiles = {
      "packages/shared/CLAUDE.md": "# shared\n",
      "packages/shared/drizzle.config.ts": "export default {};\n",
      "packages/shared/drizzle/0001_init.sql": "CREATE TABLE a(id);\n",
      "packages/shared/drizzle/meta/_journal.json": "{\"entries\":[]}\n",
    };
    for (const [path, content] of Object.entries(sharedFiles)) {
      await writeRepoFile(temp.repo, path, content);
    }
    await git(temp.repo, ["add", "-A"]);
    await git(temp.repo, ["commit", "-m", "seed packages/shared"]);
    const branchBase = await revParse(temp.repo, "main");

    // A feature branch that lands cleanly (touches an unrelated file only).
    await commitFiles(
      temp.repo,
      "feature/ak-685-retry",
      { "feature.ts": "export const x = 1;\n" },
      "feature work",
      branchBase,
    );

    // First attempt lands the branch (advances main + syncs the checkout).
    await git(temp.repo, ["checkout", "main"]);
    await mergeBranch(temp.repo, "feature/ak-685-retry", "main");
    const mainAfterFirst = await revParse(temp.repo, "main");

    // Simulate the failure that #692 describes: a subsequent merge step (the dropped
    // connection / interrupted hard reset) left the working tree with shared files
    // removed on disk, even though HEAD still references them.
    for (const path of Object.keys(sharedFiles)) {
      await rm(join(temp.repo, ...path.split("/")), { force: true });
    }
    const deletedBefore = (await git(temp.repo, ["diff", "--name-only", "--diff-filter=D", "HEAD"])).trim();
    expect(deletedBefore.split("\n").filter(Boolean).length).toBeGreaterThan(0);

    // Retrying the merge (branch already an ancestor → idempotent sync path) must
    // bring the checkout back into a clean state rather than leaving deletions.
    await mergeBranch(temp.repo, "feature/ak-685-retry", "main");

    // The branch did not re-land (already merged), and the working tree is clean:
    expect(await revParse(temp.repo, "main")).toBe(mainAfterFirst);
    expect((await git(temp.repo, ["status", "--porcelain"])).trim()).toBe("");
    for (const [path, content] of Object.entries(sharedFiles)) {
      expect(existsSync(join(temp.repo, ...path.split("/")))).toBe(true);
      expect(trimmedContent(await fileContent(temp.repo, path))).toBe(trimmedContent(content));
    }
  }, 30000);

  it("detectConflicts reports conflicts without touching HEAD, index, or working tree", async () => {
    await seedCommittedFile(
      temp.repo,
      "detect-conflict.txt",
      "line 1\nbase line\nline 3\n",
      "seed detect conflict file",
    );
    const branchBase = await revParse(temp.repo, "main");

    await commitFiles(
      temp.repo,
      "main",
      { "detect-conflict.txt": "line 1\nmain edit\nline 3\n" },
      "main edit",
      "main",
    );
    await commitFiles(
      temp.repo,
      "feature/detect-conflict",
      { "detect-conflict.txt": "line 1\nfeature edit\nline 3\n" },
      "feature edit",
      branchBase,
    );

    const beforeHead = await revParse(temp.repo, "HEAD");
    const beforeStatus = (await git(temp.repo, ["status", "--porcelain"])).trim();
    const beforeContent = await fileContent(temp.repo, "detect-conflict.txt");

    const result = await detectConflicts(temp.repo, "main");

    expect(result.hasConflicts).toBe(true);
    expect(result.conflictingFiles).toEqual(["detect-conflict.txt"]);
    expect(await revParse(temp.repo, "HEAD")).toBe(beforeHead);
    expect((await git(temp.repo, ["status", "--porcelain"])).trim()).toBe(beforeStatus);
    expect(await fileContent(temp.repo, "detect-conflict.txt")).toBe(beforeContent);
    expect(trimmedContent(beforeContent)).toBe("line 1\nfeature edit\nline 3");
    expect(beforeContent).not.toContain("<<<<<<<");
    expect(existsSync(join(temp.repo, ".git", "MERGE_HEAD"))).toBe(false);
  }, 30000);

  it("getWorkingTreeDiff includes untracked files", async () => {
    await writeRepoFile(temp.repo, "scratch/untracked.txt", "untracked content\nsecond line\n");

    const diff = await getWorkingTreeDiff(temp.repo);

    expect(diff).toContain("diff --git a/scratch/untracked.txt b/scratch/untracked.txt");
    expect(diff).toContain("new file mode 100644");
    expect(diff).toContain("+untracked content");
    expect(diff).toContain("+second line");
  }, 30000);

  it("syncBranchToHead and ensureOnBranch recover commits made from detached HEAD", async () => {
    await commitFiles(
      temp.repo,
      "feature/detached-guard",
      { "detached.txt": "attached branch commit\n" },
      "attached branch commit",
      "main",
    );
    await git(temp.repo, ["checkout", "--detach", "HEAD"]);
    await writeRepoFile(temp.repo, "detached.txt", "detached head commit\n");
    await git(temp.repo, ["add", "-A"]);
    await git(temp.repo, ["commit", "-m", "detached head work"]);
    const detachedHead = await revParse(temp.repo, "HEAD");

    expect(await getCurrentBranch(temp.repo)).toBe("HEAD");
    await expect(syncBranchToHead(temp.repo, "feature/detached-guard")).resolves.toBe(true);
    expect(await revParse(temp.repo, "feature/detached-guard")).toBe(detachedHead);
    expect(await getCurrentBranch(temp.repo)).toBe("HEAD");

    await ensureOnBranch(temp.repo, "feature/detached-guard");

    expect(await getCurrentBranch(temp.repo)).toBe("feature/detached-guard");
    expect(await revParse(temp.repo, "HEAD")).toBe(detachedHead);
    expect((await fileContent(temp.repo, "detached.txt")).trim()).toBe("detached head commit");
  }, 30000);
});
