// @covers project-registration.repair.backfill [state-transition,regression,config]
//
// repairProjectRegistration idempotently backfills DRIVEABLE state onto an old/partial
// project (project-registration.ts:231): seeds the canonical status set if it has none,
// sets defaultBranch from the repo's current branch if it is null, and populates the
// stack profile + verify (merge-gate) + setup/install scripts if they are unset — while
// NEVER clobbering values that already exist. A project registered before profiles/
// scripts existed (or with statuses/branch lost) is otherwise silently undriveable:
// POST /api/issues/batch 400s "No statuses found" and POST /api/workspaces 400s "No
// default branch configured". This no-clobber + only-when-unset contract is exactly the
// kind of guard that silently rots, so we assert BOTH halves:
//   (1) a genuinely partial project gets every field backfilled once, and
//   (2) running repair a SECOND time is a pure no-op — no duplicate status rows, no
//       changed branch/profile/verify/setup, and every returned flag false.
//
// This drives the REAL repairProjectRegistration against a REAL temp git+node repo, with
// the global db swapped for an in-memory test db (the repair path uses no db.transaction(),
// so :memory: is safe here — mirrors registration-resolve-default-branch.test.ts).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Swap the global db for a fresh in-memory libsql db so repairProjectRegistration (which
// writes through the default-arg `db` of its repository/preference functions) hits a
// throwaway database. withTransaction/writeDb are provided for transitive importers.
vi.mock("../db/index.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  const schemaMod = await import("@agentic-kanban/shared/schema");
  const { db } = createTestDb();
  return {
    db,
    writeDb: db,
    rawClient: undefined,
    rawWriteClient: undefined,
    schema: schemaMod,
    withDbRetry: <T>(fn: () => Promise<T>) => fn(),
    withTransaction: <T>(database: { transaction: (fn: unknown) => Promise<T> }, fn: unknown) =>
      database.transaction(fn),
  };
});

import { describe, it, expect, vi, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { projects, projectStatuses } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import { repairProjectRegistration } from "../services/project-registration.js";
import {
  getStackProfile,
  verifyScriptPrefKey,
} from "../services/stack-profile.service.js";
import { getPreference } from "../repositories/preferences.repository.js";

/**
 * A real git repo on `branch` carrying a deterministic node/pnpm single-package stack
 * (package.json scripts test+build + pnpm-lock.yaml). detectStackProfile returns a
 * NON-sparse profile (stack=node, test+build present), so the LLM gap-fill never fires —
 * the derivation is fully deterministic. Returns the repo path.
 */
function makeNodeRepo(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kanban-repair-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-b", branch);
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Repair Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "repairee", scripts: { test: "vitest", build: "tsc" } }),
  );
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  git("add", ".");
  git("commit", "-m", "initial");
  return dir;
}

/** Insert a deliberately PARTIAL project row: null defaultBranch, no setup_script, and
 *  (separately) no statuses / no profile / no verify pref are seeded. */
async function seedPartialProject(repoPath: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(projects).values({
    id,
    name: "repairee",
    repoPath,
    repoName: "repairee",
    defaultBranch: null,
    setupScript: null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function statusIds(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId));
  return rows.map((r) => r.id).sort();
}

async function branchOf(projectId: string): Promise<string | null> {
  const [row] = await db.select({ b: projects.defaultBranch }).from(projects).where(eq(projects.id, projectId));
  return row.b ?? null;
}

async function setupOf(projectId: string): Promise<string | null> {
  const [row] = await db.select({ s: projects.setupScript }).from(projects).where(eq(projects.id, projectId));
  return row.s ?? null;
}

describe("repairProjectRegistration — idempotent backfill (#772/#786/#788/#810)", () => {
  const dirs: string[] = [];

  afterAll(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  });

  it("backfills statuses, branch, profile, verify and setup onto a partial project", async () => {
    const repo = makeNodeRepo("trunk");
    dirs.push(repo);
    const projectId = await seedPartialProject(repo);

    // Precondition: genuinely partial — nothing seeded yet.
    expect(await statusIds(projectId)).toHaveLength(0);
    expect(await branchOf(projectId)).toBeNull();
    expect(await getStackProfile(projectId, db)).toBeNull();
    expect(await getPreference(verifyScriptPrefKey(projectId), db)).toBeNull();
    expect(await setupOf(projectId)).toBeNull();

    const result = await repairProjectRegistration(projectId);

    // Every backfill ran and reported itself.
    expect(result.seededStatuses).toBe(true);
    expect(result.setDefaultBranch).toBe("trunk");
    expect(result.populatedStackProfile).toBe(true);
    expect(result.populatedVerifyScript).toBe(true);
    expect(result.populatedSetupScript).toBe(true);

    // Observable outcome: the project is now driveable.
    expect((await statusIds(projectId)).length).toBeGreaterThanOrEqual(5); // canonical set seeded
    expect(await branchOf(projectId)).toBe("trunk");

    const profile = await getStackProfile(projectId, db);
    expect(profile?.stack).toBe("node");

    // Derived merge gate = test && build; setup = install — deterministic from the node fixture.
    expect(await getPreference(verifyScriptPrefKey(projectId), db)).toBe("pnpm test && pnpm build");
    expect(await setupOf(projectId)).toBe("pnpm install");
  });

  it("is a pure no-op on a second run (idempotent — no duplicate rows, nothing changed)", async () => {
    const repo = makeNodeRepo("trunk");
    dirs.push(repo);
    const projectId = await seedPartialProject(repo);

    // First repair fills everything.
    const first = await repairProjectRegistration(projectId);
    expect(first.seededStatuses).toBe(true);

    // Snapshot the filled state.
    const statusesBefore = await statusIds(projectId);
    const branchBefore = await branchOf(projectId);
    const profileBefore = JSON.stringify(await getStackProfile(projectId, db));
    const verifyBefore = await getPreference(verifyScriptPrefKey(projectId), db);
    const setupBefore = await setupOf(projectId);
    expect(statusesBefore.length).toBeGreaterThanOrEqual(5);

    // Second repair: must report NOTHING repaired …
    const second = await repairProjectRegistration(projectId);
    expect(second.seededStatuses).toBe(false);
    expect(second.setDefaultBranch).toBeNull();
    expect(second.populatedStackProfile).toBe(false);
    expect(second.populatedVerifyScript).toBe(false);
    expect(second.populatedSetupScript).toBe(false);

    // … and leave every value byte-identical. Crucially the status set is NOT duplicated
    // (a lost `existingStatuses.length === 0` guard would re-seed and double the rows).
    expect(await statusIds(projectId)).toEqual(statusesBefore);
    expect(await branchOf(projectId)).toBe(branchBefore);
    expect(JSON.stringify(await getStackProfile(projectId, db))).toBe(profileBefore);
    expect(await getPreference(verifyScriptPrefKey(projectId), db)).toBe(verifyBefore);
    expect(await setupOf(projectId)).toBe(setupBefore);
  });

  it("never clobbers values that are already present (no-clobber on a half-filled project)", async () => {
    const repo = makeNodeRepo("trunk");
    dirs.push(repo);
    const id = randomUUID();
    const now = new Date().toISOString();
    // A half-filled project: branch + setup already set by a user/AI; statuses/profile/verify absent.
    await db.insert(projects).values({
      id,
      name: "half",
      repoPath: repo,
      repoName: "half",
      defaultBranch: "release-9",
      setupScript: "make bootstrap",
      createdAt: now,
      updatedAt: now,
    });

    const result = await repairProjectRegistration(id);

    // The already-present branch + setup are preserved (not re-derived/overwritten).
    expect(result.setDefaultBranch).toBeNull(); // branch was non-null → untouched
    expect(result.populatedSetupScript).toBe(false); // setup was set → untouched
    expect(await branchOf(id)).toBe("release-9");
    expect(await setupOf(id)).toBe("make bootstrap");

    // The genuinely-missing pieces are still backfilled.
    expect(result.seededStatuses).toBe(true);
    expect((await statusIds(id)).length).toBeGreaterThanOrEqual(5);
    expect(result.populatedVerifyScript).toBe(true);
    expect(await getPreference(verifyScriptPrefKey(id), db)).toBe("pnpm test && pnpm build");
  });
});
