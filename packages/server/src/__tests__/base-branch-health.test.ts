/**
 * #491 — base-branch health: the base branch's verify result is recorded per sha and readable,
 * and a red base plus a green branch produces a gate message that attributes the failure to the
 * base rather than the branch under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { runSetupScript as realRunSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projects, baseBranchHealth } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import {
  recordBaseBranchHealth,
  getLatestBaseBranchHealth,
  getBaseBranchHealthForSha,
} from "../repositories/base-branch-health.repository.js";

// #674: verifyBaseBranchHealth must INSTALL the clone before running verify_script, and must
// record "unverified" (never "red") when the install itself fails. Mock the two shared
// primitives it calls so the test drives that orchestration without spawning real git/pnpm.
const runSetupScript = vi.fn<typeof realRunSetupScript>();
vi.mock("@agentic-kanban/shared/lib/setup-script", () => ({
  runSetupScript: (...args: Parameters<typeof realRunSetupScript>) => runSetupScript(...args),
}));
const cloneBranchTo = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@agentic-kanban/shared/lib/git-service", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, cloneBranchTo: (...args: unknown[]) => cloneBranchTo(...args) };
});

const { verifyBaseBranchHealth, getBaseBranchHealthAtMergeBase, describeRedBaseAttribution } =
  await import("../services/base-branch-health.service.js");
const { saveStackProfile } = await import("../services/stack-profile.service.js");
const { setPreference } = await import("../repositories/preferences.repository.js");
const { verifyScriptPrefKey } = await import("../services/stack-profile.service.js");

const tempRepos: string[] = [];
function makeRepoPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ak-base-branch-health-repo-"));
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
        failedSuites: null,
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
        failedSuites: null,
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
        failedSuites: null,
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

  it("falls back to the latest row when it IS an ancestor of the merge-base, with recordedSha/ageMs on the result (#886)", async () => {
    const repoPath = makeRepoPath();
    const projectId = await seedProject(db, repoPath);

    const { execFileSync } = await import("node:child_process");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" });
    git("init", "-q", "-b", "master");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("commit", "--allow-empty", "-q", "-m", "root");
    const oldProbedSha = git("rev-parse", "HEAD").trim();
    // Master moves forward past the probed sha WITHOUT a new probe recorded — the
    // scheduled/post-merge check that lags behind commits.
    git("commit", "--allow-empty", "-q", "-m", "master moves on, unprobed");
    const mergeBaseSha = git("rev-parse", "HEAD").trim();
    git("checkout", "-q", "-b", "feature/y");
    git("commit", "--allow-empty", "-q", "-m", "feature commit");

    const rowId = await recordBaseBranchHealth(
      { projectId, sha: oldProbedSha, branch: "master", outcome: "red", message: "still red" },
      db,
    );
    // Backdate the row directly (the repository always stamps `new Date()`; this test
    // needs a controllable age to assert `ageMs`/the rendered "Nh ago").
    const probedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await db.update(baseBranchHealth).set({ createdAt: probedAt }).where(eq(baseBranchHealth.id, rowId));

    const result = await getBaseBranchHealthAtMergeBase(projectId, repoPath, "feature/y", "master", db);
    expect(result.mergeBaseSha).toBe(mergeBaseSha);
    expect(result.health?.outcome).toBe("red");
    expect(result.recordedSha).toBe(oldProbedSha);
    expect(result.ageMs).toBeGreaterThanOrEqual(3 * 60 * 60 * 1000 - 5000);

    const attribution = describeRedBaseAttribution(result);
    expect(attribution).toContain("BASE BRANCH ALREADY RED");
    expect(attribution).toContain("as of the last check");
    expect(attribution).toContain("checked 3h ago");
  });

  it("does NOT present a latest row that is NOT an ancestor of the merge-base — reports unknown instead of a stale red (#886)", async () => {
    const repoPath = makeRepoPath();
    const projectId = await seedProject(db, repoPath);

    const { execFileSync } = await import("node:child_process");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" });
    git("init", "-q", "-b", "master");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("commit", "--allow-empty", "-q", "-m", "root");
    const rootSha = git("rev-parse", "HEAD").trim();
    git("commit", "--allow-empty", "-q", "-m", "old red commit");
    const staleProbedSha = git("rev-parse", "HEAD").trim();
    // Rewind master and move it forward on a DIFFERENT commit — the stale probed sha is
    // now a sibling of the new tip, not an ancestor of it (simulates a rebase past a fix).
    git("reset", "--hard", rootSha);
    git("commit", "--allow-empty", "-q", "-m", "the actual fix, superseding the stale probe");
    const mergeBaseSha = git("rev-parse", "HEAD").trim();
    git("checkout", "-q", "-b", "feature/z");
    git("commit", "--allow-empty", "-q", "-m", "feature commit");

    await recordBaseBranchHealth(
      { projectId, sha: staleProbedSha, branch: "master", outcome: "red", message: "old failure, since fixed" },
      db,
    );

    const result = await getBaseBranchHealthAtMergeBase(projectId, repoPath, "feature/z", "master", db);
    expect(result.mergeBaseSha).toBe(mergeBaseSha);
    expect(result.health).toBeNull();

    const attribution = describeRedBaseAttribution(result);
    expect(attribution).toBeNull();
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

// #674 — verifyBaseBranchHealth's actual orchestration: it must install the clone before
// running verify_script, and must record "unverified" (not "red") when the install itself
// fails, keeping the raw failure text so the gate can quote WHAT failed instead of just the
// head of a combined log.
describe("verifyBaseBranchHealth — installs before verifying (#674)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  function makeRealGitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "ak-base-branch-health-realrepo-"));
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "master");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("commit", "--allow-empty", "-q", "-m", "base commit");
    tempRepos.push(dir);
    return dir;
  }

  beforeEach(() => {
    ({ db } = createTestDb());
    runSetupScript.mockReset();
    cloneBranchTo.mockClear();
  });

  it("runs the derived install command before verify_script, and only verify_script decides green/red", async () => {
    const repoPath = makeRealGitRepo();
    const projectId = await seedProject(db, repoPath);
    await setPreference(verifyScriptPrefKey(projectId), "pnpm test", db);
    await saveStackProfile(
      projectId,
      {
        stack: "node", packageManager: "pnpm", isMonorepo: true, workspaces: ["packages/*"],
        installCommand: "pnpm install -r", buildCommand: null, testCommand: "pnpm test",
        quickTestCommand: null, lintCommand: null, typecheckCommand: null, devCommand: null,
        isWeb: false, devHealthUrl: null, devPort: null, testDir: null, testRunner: null,
        source: "detected", detectedMarkers: [], updatedAt: new Date().toISOString(),
      },
      db,
    );

    const calls: string[] = [];
    runSetupScript.mockImplementation(async (_dest: string, command: string) => {
      calls.push(command);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    });

    const result = await verifyBaseBranchHealth(projectId, db);

    expect(calls).toEqual(["pnpm install -r", "pnpm test"]);
    expect(result?.outcome).toBe("green");
    expect(cloneBranchTo).toHaveBeenCalledTimes(1);
  });

  it("records 'unverified' (never 'red') when the install itself fails, without running verify_script", async () => {
    const repoPath = makeRealGitRepo();
    const projectId = await seedProject(db, repoPath);
    await setPreference(verifyScriptPrefKey(projectId), "pnpm test", db);
    await saveStackProfile(
      projectId,
      {
        stack: "node", packageManager: "pnpm", isMonorepo: true, workspaces: ["packages/*"],
        installCommand: "pnpm install -r", buildCommand: null, testCommand: "pnpm test",
        quickTestCommand: null, lintCommand: null, typecheckCommand: null, devCommand: null,
        isWeb: false, devHealthUrl: null, devPort: null, testDir: null, testRunner: null,
        source: "detected", detectedMarkers: [], updatedAt: new Date().toISOString(),
      },
      db,
    );

    runSetupScript.mockImplementation(async (_dest: string, command: string) => {
      if (command === "pnpm install -r") {
        return { exitCode: 1, stdout: "", stderr: "ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL: shared has no dist" };
      }
      throw new Error("verify_script must not run when install failed");
    });

    const result = await verifyBaseBranchHealth(projectId, db);

    expect(result?.outcome).toBe("unverified");
    expect(result?.message).toContain("pnpm install -r");
    expect(result?.message).toContain("shared has no dist");
    expect(result?.message).not.toBeUndefined();
  });

  it("surfaces the tail (the failing step) of a red verify run, not the head of the log", async () => {
    const repoPath = makeRealGitRepo();
    const projectId = await seedProject(db, repoPath);
    await setPreference(verifyScriptPrefKey(projectId), "pnpm check:arch && pnpm test", db);

    const headNoise = Array.from({ length: 60 }, (_, i) => `head noise line ${i} (depcruise: 0 errors)`).join("\n");
    const realFailure = "ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command failed with exit code 1: vitest run src/__tests__/mcp-catalog-parity.test.ts";
    runSetupScript.mockImplementation(async () => ({
      exitCode: 1,
      stdout: `${headNoise}\n${realFailure}`,
      stderr: "",
    }));

    const result = await verifyBaseBranchHealth(projectId, db);

    expect(result?.outcome).toBe("red");
    expect(result?.message).toContain(realFailure);
    expect(result?.message).not.toContain("head noise line 0 ");
  });
});
