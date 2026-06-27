// @covers project-registration.register.idempotent [workflow,boundary]
//
// Re-registering the SAME git repo must NOT create a duplicate project — registerProject
// returns the already-registered project with created=false (project-registration.ts:150-161).
// Three ways the "same repo" arrives, all of which must collapse onto the one project:
//   (1) WORKFLOW: the identical path registered twice — the second call finds the project by
//       its stored git-root repoPath (the :151 exact-match branch) and returns it, created=false;
//   (2) BOUNDARY: a SUBDIRECTORY of the repo — detectRepoInfo() resolves it to the same git
//       root (git-info.service.ts:48-79), so the exact-match branch still fires;
//   (3) BOUNDARY (legacy): a project whose STORED repoPath is a subdir (a pre-git-root-resolution
//       registration). The exact-match misses, so the async fallback (:152-158) must resolve each
//       stored path's git root via `git rev-parse --show-toplevel` and find the match that way.
// In every case the observable outcome is: created===false, the SAME project id, exactly one
// project row, and the canonical status set seeded ONCE (not doubled). A regression that dropped
// the dedup guard would, on the second register, insert a second project row + a second status
// set — fragmenting the repo's issues across two projects.
//
// This drives the REAL registerProject() against REAL temp git repos with the global db swapped
// for an in-memory test db (registerProject uses no db.transaction(), so :memory: is safe here —
// mirrors registration-resolve-default-branch.test.ts).

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

// Swap the global db for a fresh in-memory libsql db so registerProject() (which writes through
// the default-arg `db` of its repository functions) hits a throwaway database.
// withTransaction/writeDb are provided for transitive importers of ../db/index.js.
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
import { registerProject } from "../services/project-registration.js";

/** Create a real git repo with one commit on `main`; return its resolved root path. */
function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kanban-idem-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Idempotent Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git("add", "README.md");
  git("commit", "-m", "initial");
  // detectRepoInfo resolves to `git rev-parse --show-toplevel`; mirror that normalization so our
  // assertions compare against the exact path the service stores (avoids /private symlink drift).
  return resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir }).toString().trim());
}

async function projectRows() {
  return db.select().from(projects);
}

/** Project rows whose stored repoPath is at or under `repo` — scopes assertions to one fixture,
 *  since the in-memory db is shared across every test in this file. */
async function rowsForRepo(repo: string) {
  const rows = await projectRows();
  return rows.filter((r) => r.repoPath === repo || r.repoPath.startsWith(repo + "/") || r.repoPath.startsWith(repo + "\\"));
}

async function statusCount(projectId: string): Promise<number> {
  const rows = await db
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId));
  return rows.length;
}

describe("registerProject — idempotent on the same git root (no duplicate project)", () => {
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

  it("registering the IDENTICAL path twice returns the existing project (created=false, one row)", async () => {
    const repo = makeGitRepo();
    dirs.push(repo);

    const first = await registerProject(repo);
    expect(first.created).toBe(true);

    // Snapshot the seeded state after the first registration: one project, one canonical status set.
    expect(await rowsForRepo(repo)).toHaveLength(1);
    const seededStatuses = await statusCount(first.project.id);
    expect(seededStatuses).toBeGreaterThanOrEqual(5);

    // Second registration of the very same path: returns the SAME project, created=false …
    const second = await registerProject(repo);
    expect(second.created).toBe(false);
    expect(second.project.id).toBe(first.project.id);

    // … and creates NOTHING new — still exactly one project row, status set not duplicated.
    expect(await rowsForRepo(repo)).toHaveLength(1);
    expect(await statusCount(first.project.id)).toBe(seededStatuses);
  });

  it("registering a SUBDIRECTORY of the repo resolves to the same root → same project (boundary)", async () => {
    const repo = makeGitRepo();
    dirs.push(repo);
    const sub = join(repo, "packages", "server");
    mkdirSync(sub, { recursive: true });

    const fromRoot = await registerProject(repo);
    expect(fromRoot.created).toBe(true);
    const statusesAfterRoot = await statusCount(fromRoot.project.id);

    // detectRepoInfo() resolves the subdir to the git root, so this is the SAME repo.
    const fromSub = await registerProject(sub);
    expect(fromSub.created).toBe(false);
    expect(fromSub.project.id).toBe(fromRoot.project.id);

    // Only the one project from this repo exists, with its single (un-duplicated) status set.
    expect(await rowsForRepo(repo)).toHaveLength(1);
    expect(await statusCount(fromRoot.project.id)).toBe(statusesAfterRoot);
  });

  it("matches a LEGACY project whose stored repoPath is a subdir, via git-root resolution (boundary)", async () => {
    // A project registered before git-root resolution existed: its repoPath is a SUBDIR, so the
    // exact-path match misses and the async fallback (:152-158) must resolve each stored path's
    // git root to find it. We seed that legacy row directly to reproduce the pre-resolution shape.
    const repo = makeGitRepo();
    dirs.push(repo);
    const sub = join(repo, "apps", "web");
    mkdirSync(sub, { recursive: true });

    const legacyId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(projects).values({
      id: legacyId,
      name: "legacy",
      repoPath: sub, // stored as a SUBDIR (legacy) — NOT the git root
      repoName: "legacy",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
    expect(await rowsForRepo(repo)).toHaveLength(1);

    // Registering the ROOT must find the legacy subdir project via `git rev-parse --show-toplevel`,
    // NOT create a second row.
    const result = await registerProject(repo);
    expect(result.created).toBe(false);
    expect(result.project.id).toBe(legacyId);

    // No duplicate created — the single legacy row (under this repo) is still the only project for it.
    const rows = await rowsForRepo(repo);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(legacyId);
  });
});
