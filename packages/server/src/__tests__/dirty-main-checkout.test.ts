import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { getDirtyTrackedSourceFiles } from "../services/dirty-main-checkout.js";

const execFileAsync = promisify(execFile);

let repoDir: string | null = null;

async function git(args: string[]) {
  if (!repoDir) throw new Error("repoDir not initialized");
  await execFileAsync("git", args, { cwd: repoDir, windowsHide: true });
}

async function initRepo() {
  repoDir = await mkdtemp(join(tmpdir(), "ak-dirty-main-"));
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test User"]);
  await mkdir(join(repoDir, "packages", "server", "src"), { recursive: true });
  await mkdir(join(repoDir, "docs"), { recursive: true });
  await writeFile(join(repoDir, "packages", "server", "src", "index.ts"), "export const value = 1;\n");
  await writeFile(join(repoDir, "docs", "note.md"), "hello\n");
  await git(["add", "."]);
  await git(["commit", "-m", "initial"]);
}

afterEach(async () => {
  if (repoDir) {
    await rm(repoDir, { recursive: true, force: true });
    repoDir = null;
  }
});

describe("getDirtyTrackedSourceFiles", () => {
  it("detects tracked package source changes", async () => {
    await initRepo();
    await writeFile(join(repoDir!, "packages", "server", "src", "index.ts"), "export const value = 2;\n");

    await expect(getDirtyTrackedSourceFiles(repoDir!)).resolves.toEqual(["packages/server/src/index.ts"]);
  });

  it("ignores untracked source files", async () => {
    await initRepo();
    await writeFile(join(repoDir!, "packages", "server", "src", "new-file.ts"), "export const value = 2;\n");

    await expect(getDirtyTrackedSourceFiles(repoDir!)).resolves.toEqual([]);
  });

  it("ignores tracked changes outside packages source pathspecs", async () => {
    await initRepo();
    await writeFile(join(repoDir!, "docs", "note.md"), "changed\n");

    await expect(getDirtyTrackedSourceFiles(repoDir!)).resolves.toEqual([]);
  });
});
