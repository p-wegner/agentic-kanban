/**
 * #491 — base-branch health: the base branch's verify result is recorded per sha and readable,
 * and a red base plus a green branch produces a gate message that attributes the failure to the
 * base rather than the branch under test.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projects } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  recordBaseBranchHealth,
  getLatestBaseBranchHealth,
  getBaseBranchHealthForSha,
} from "../repositories/base-branch-health.repository.js";
import {
  getBaseBranchHealthAtMergeBase,
  describeRedBaseAttribution,
} from "../services/base-branch-health.service.js";

const tempRepos: string[] = [];
function makeRepoPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "base-branch-health-repo-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  tempRepos.push(dir);
  return dir;
}

async function seedProject(db: ReturnType<typeof createTestDb>["db"], repoPath: string) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "Base Branch Health Project",
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

describe("base-branch-health repository (#491)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("records a verify result per sha and reads it back as the latest", async () => {
    const repoPath = makeRepoPath();
    const projectId = await seedProject(db, repoPath);

    await recordBaseBranchHealth(
      { projectId, sha: "aaa111", branch: "master", outcome: "green", durationMs: 1200 },
      db,
    );
    await recordBaseBranchHealth(
      { projectId, sha: "bbb222", branch: "master", outcome: "red", durationMs: 900, message: "verify_script failed (exit 1)" },
      db,
    );

    const latest = await getLatestBaseBranchHealth(projectId, db);
    expect(latest?.sha).toBe("bbb222");
    expect(latest?.outcome).toBe("red");
    expect(latest?.message).toContain("verify_script failed");

    const bySha = await getBaseBranchHealthForSha(projectId, "aaa111", db);
    expect(bySha?.outcome).toBe("green");
  });

  it("returns null for a project with no recorded history", async () => {
    const repoPath = makeRepoPath();
    const projectId = await seedProject(db, repoPath);
    expect(await getLatestBaseBranchHealth(projectId, db)).toBeNull();
    expect(await getBaseBranchHealthForSha(projectId, "does-not-exist", db)).toBeNull();
  });
});

describe("describeRedBaseAttribution (#491)", () => {
  it("attributes a branch gate failure to an already-red base at the merge-base sha", () => {
    const attribution = describeRedBaseAttribution({
      mergeBaseSha: "deadbeef00000000000000000000000000000000",
      health: {
        id: "row-1",
        projectId: "p1",
        sha: "deadbeef00000000000000000000000000000000",
        branch: "master",
        outcome: "red",
        durationMs: 500,
        message: "verify_script failed (exit 1): TypeError somewhere",
        createdAt: new Date().toISOString(),
      },
    });
    expect(attribution).not.toBeNull();
    expect(attribution).toContain("BASE BRANCH ALREADY RED");
    expect(attribution).toContain("branch's merge-base");
    expect(attribution).toContain("TypeError somewhere");
  });

  it("returns null when the base was green", () => {
    const attribution = describeRedBaseAttribution({
      mergeBaseSha: "sha1",
      health: {
        id: "row-1",
        projectId: "p1",
        sha: "sha1",
        branch: "master",
        outcome: "green",
        durationMs: 500,
        message: null,
        createdAt: new Date().toISOString(),
      },
    });
    expect(attribution).toBeNull();
  });

  it("returns null when nothing was ever recorded for this project", () => {
    expect(describeRedBaseAttribution({ mergeBaseSha: "sha1", health: null })).toBeNull();
  });

  it("falls back to the latest known result when the merge-base sha itself was never verified", () => {
    const attribution = describeRedBaseAttribution({
      mergeBaseSha: "unrecorded-sha",
      health: {
        id: "row-1",
        projectId: "p1",
        sha: "older-sha",
        branch: "master",
        outcome: "red",
        durationMs: 500,
        message: "still broken",
        createdAt: new Date().toISOString(),
      },
    });
    expect(attribution).not.toBeNull();
    expect(attribution).toContain("as of the last check");
    expect(attribution).toContain("still broken");
  });
});

describe("getBaseBranchHealthAtMergeBase (#491)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("resolves the health row recorded at the branch's actual merge-base commit", async () => {
    const repoPath = makeRepoPath();
    const projectId = await seedProject(db, repoPath);

    // Build a tiny real git history: base branch commit (the merge-base), then a feature
    // branch diverging from it, so getMergeBase has real history to resolve.
    const { execFileSync } = await import("node:child_process");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" });
    git("init", "-q", "-b", "master");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("commit", "--allow-empty", "-q", "-m", "base commit");
    const mergeBaseSha = git("rev-parse", "HEAD").trim();
    git("checkout", "-q", "-b", "feature/x");
    git("commit", "--allow-empty", "-q", "-m", "feature commit");

    await recordBaseBranchHealth(
      { projectId, sha: mergeBaseSha, branch: "master", outcome: "red", message: "master is broken" },
      db,
    );

    const result = await getBaseBranchHealthAtMergeBase(projectId, repoPath, "feature/x", "master", db);
    expect(result.mergeBaseSha).toBe(mergeBaseSha);
    expect(result.health?.outcome).toBe("red");
    expect(result.health?.message).toBe("master is broken");

    const attribution = describeRedBaseAttribution(result);
    expect(attribution).toContain("BASE BRANCH ALREADY RED");
    expect(attribution).toContain("master is broken");
  });
});

// #674 — an UNVERIFIED base (the probe could not prepare its clone: no install, so
// generated artifacts like shared/dist are absent and every suite importing them fails)
// must NOT be attributed to the base. The old code recorded that as `red`, which made the
// gate blame the base and withhold EVERY merge on the project while master was in fact green.
describe("base-branch-health — unverified is not a red base (#674)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("attributes an unverified base as UNKNOWN, never as ALREADY RED", async () => {
    const repoPath = makeRepoPath();
    const projectId = await seedProject(db, repoPath);
    const sha = "abc1234567890abcdef1234567890abcdef123456";
    await recordBaseBranchHealth(
      {
        projectId,
        sha,
        branch: "master",
        outcome: "unverified",
        durationMs: 1234,
        message: "could not prepare the base clone — `pnpm install -r` failed (exit 1).",
      },
      db,
    );

    const health = await getBaseBranchHealthForSha(projectId, sha, db);
    const attribution = describeRedBaseAttribution({ mergeBaseSha: sha, health });

    expect(attribution).not.toBeNull();
    expect(attribution).toContain("BASE BRANCH HEALTH UNKNOWN");
    // The whole point: it must not read as an accusation against the base.
    expect(attribution).not.toContain("ALREADY RED");
    expect(attribution).not.toContain("ALREADY UNVERIFIED");
    expect(attribution).toContain("NOT attributed to it");
  });

  it("still attributes a genuinely red base as ALREADY RED", async () => {
    const repoPath = makeRepoPath();
    const projectId = await seedProject(db, repoPath);
    const sha = "def1234567890abcdef1234567890abcdef123456";
    await recordBaseBranchHealth(
      { projectId, sha, branch: "master", outcome: "red", durationMs: 10, message: "1 test failed" },
      db,
    );

    const health = await getBaseBranchHealthForSha(projectId, sha, db);
    const attribution = describeRedBaseAttribution({ mergeBaseSha: sha, health });

    expect(attribution).toContain("BASE BRANCH ALREADY RED");
  });
});
