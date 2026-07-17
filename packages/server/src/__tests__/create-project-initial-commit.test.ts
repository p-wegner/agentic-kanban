// #47 — `createProject` (POST /api/projects/create) git-inits its own directory, which leaves
// HEAD on an UNBORN branch: a `.git` with no commits. Everything downstream assumes a born HEAD.
// `commitProjectScaffoldArtifacts` resolved the branch first, and on an unborn branch `git
// rev-parse --abbrev-ref HEAD` does not report "HEAD" — it FAILS. The throw landed in the
// function's non-fatal catch, so the board's scaffold was never committed on this path and got
// swept into the first agent's feature commit by its end-of-task `git add -A` (the #38/#41
// dirty-main family, on the one path those fixes did not cover).
//
// These tests pin both halves of the fix: createProject lands an initial commit, and the unborn
// case is now an explicit state rather than a swallowed exception.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getHeadState } from "@agentic-kanban/shared/lib/git-service";
import { db } from "../db/index.js";
import { createProjectService } from "../services/project.service.js";
import { setPreference } from "../repositories/preferences.repository.js";
import { commitProjectScaffoldArtifacts } from "../services/project-scaffold.js";

const dirs: string[] = [];

function makeBaseDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kanban-${prefix}-`));
  dirs.push(dir);
  return dir;
}

const git = (repo: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe", windowsHide: true });

async function createFreshProject(prefix: string, body: Record<string, unknown> = {}) {
  const targetPath = join(makeBaseDir(prefix), "app");
  const service = createProjectService({ database: db });
  const result = await service.createProject({ name: `p-${prefix}`, path: targetPath, ...body });
  return { result, repoPath: targetPath };
}

beforeAll(async () => {
  await setPreference("export_skills_on_registration", "false", db);
});

afterAll(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("getHeadState — an unborn branch is a state, not an error (#47)", () => {
  it("reports `unborn` for a fresh git init, where getCurrentBranch would throw", async () => {
    const repo = makeBaseDir("headstate-unborn");
    git(repo, "init", "-q", "-b", "main");

    // The exact call the old guard made. It does not return "HEAD" — it fails outright, which
    // is why `branch === "HEAD"` never fired and the throw did the control flow instead.
    expect(() => git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toThrow();

    expect(await getHeadState(repo)).toEqual({ kind: "unborn", branch: "main" });
  });

  it("still distinguishes a born branch from a detached HEAD", async () => {
    const repo = makeBaseDir("headstate-born");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "one");

    expect(await getHeadState(repo)).toEqual({ kind: "branch", branch: "main" });

    git(repo, "checkout", "-q", "--detach");
    expect(await getHeadState(repo)).toEqual({ kind: "detached" });
  });
});

describe("commitProjectScaffoldArtifacts on an unborn branch (#47)", () => {
  it("commits the scaffold instead of dying in the non-fatal catch", async () => {
    const repo = makeBaseDir("scaffold-unborn");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "t");
    git(repo, "config", "user.email", "t@t");
    writeFileSync(join(repo, "CLAUDE.md"), "# guide\n", "utf8");

    await commitProjectScaffoldArtifacts(repo);

    // A repo's first commit IS a normal commit — the unborn case never needed skipping.
    expect(git(repo, "ls-files").trim().split("\n")).toContain("CLAUDE.md");
  });

  it("still skips a detached HEAD", async () => {
    const repo = makeBaseDir("scaffold-detached");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "t");
    git(repo, "config", "user.email", "t@t");
    git(repo, "commit", "--allow-empty", "-m", "one");
    git(repo, "checkout", "-q", "--detach");
    writeFileSync(join(repo, "CLAUDE.md"), "# guide\n", "utf8");

    await commitProjectScaffoldArtifacts(repo);

    expect(git(repo, "ls-files").trim()).toBe("");
  });
});

describe("createProject gives the fresh repo a born HEAD (#47)", () => {
  it("lands an initial commit, so the scaffold commit is reachable at all", async () => {
    const { repoPath } = await createFreshProject("init-commit");

    expect(await getHeadState(repoPath)).toMatchObject({ kind: "branch" });

    // Two commits, in this order: the repo's birth, then the board's scaffold as its OWN
    // commit — the same shape registerProject produces for an imported repo.
    const subjects = git(repoPath, "log", "--format=%s").trim().split("\n");
    expect(subjects).toEqual([
      "chore: scaffold agent guards and onboarding",
      "chore: initialise repository",
    ]);
  });

  it("commits the generated README as the repo's first commit rather than leaving it untracked", async () => {
    const { repoPath } = await createFreshProject("init-readme", { generateReadme: true });

    expect(existsSync(join(repoPath, "README.md"))).toBe(true);
    expect(git(repoPath, "ls-files").split("\n").map((l) => l.trim())).toContain("README.md");
    expect(
      git(repoPath, "show", "--name-only", "--format=", "HEAD~1").trim(),
      "the README is what the initial commit contains",
    ).toBe("README.md");
  });

  it("leaves no board-authored file untracked for the first agent's `git add -A` to sweep up", async () => {
    const { repoPath } = await createFreshProject("init-clean", { generateReadme: true });

    const untracked = git(repoPath, "status", "--porcelain", "--untracked-files=all")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("??"));
    expect(untracked).toEqual([]);
  });
});
