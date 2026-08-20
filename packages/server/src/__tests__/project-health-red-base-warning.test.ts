/**
 * #491 — a red base is visible on the board without opening a log. `getProjectHealth`
 * (consumed by the Project Health Overview panel) surfaces the base branch's last recorded
 * verify result as a warning, straight off a cheap DB read — no live git/verify run.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { projects } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { recordBaseBranchHealth } from "../repositories/base-branch-health.repository.js";
import { getProjectHealth } from "../services/project-health.service.js";

const tempRepos: string[] = [];
function makeRealRepoPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "project-health-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "master");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("commit", "--allow-empty", "-q", "-m", "init");
  tempRepos.push(dir);
  return dir;
}

async function seedProject(db: ReturnType<typeof createTestDb>["db"], repoPath: string) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "Health Warning Project",
    repoPath,
    repoName: "repo",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });
  return projectId;
}

afterEach(() => {
  while (tempRepos.length) {
    try { rmSync(tempRepos.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("getProjectHealth surfaces a red base branch as a warning (#491)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("adds a warning when the latest recorded base-branch health is red", async () => {
    const repoPath = makeRealRepoPath();
    const projectId = await seedProject(db, repoPath);
    await recordBaseBranchHealth(
      { projectId, sha: "deadbeef00000000000000000000000000000000", branch: "master", outcome: "red", message: "verify_script failed" },
      db,
    );

    const result = await getProjectHealth(db);
    const entry = result.projects.find((p) => p.id === projectId);
    expect(entry).toBeDefined();
    expect(entry!.warnings.some((w) => w.includes("Base branch 'master' is RED"))).toBe(true);
  });

  it("adds NO base-branch warning when the latest recorded result is green", async () => {
    const repoPath = makeRealRepoPath();
    const projectId = await seedProject(db, repoPath);
    await recordBaseBranchHealth(
      { projectId, sha: "deadbeef00000000000000000000000000000000", branch: "master", outcome: "green" },
      db,
    );

    const result = await getProjectHealth(db);
    const entry = result.projects.find((p) => p.id === projectId);
    expect(entry).toBeDefined();
    expect(entry!.warnings.some((w) => w.includes("Base branch"))).toBe(false);
  });

  it("adds NO base-branch warning when nothing was ever recorded", async () => {
    const repoPath = makeRealRepoPath();
    const projectId = await seedProject(db, repoPath);

    const result = await getProjectHealth(db);
    const entry = result.projects.find((p) => p.id === projectId);
    expect(entry).toBeDefined();
    expect(entry!.warnings.some((w) => w.includes("Base branch"))).toBe(false);
  });
});
