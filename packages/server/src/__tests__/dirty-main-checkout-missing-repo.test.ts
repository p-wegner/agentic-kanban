// #208: a project whose repoPath no longer exists on disk (moved/deleted worktree, stale
// registration) must be SKIPPED by the dirty-main-checkout scan instead of re-spawning git
// against a missing cwd every monitor cycle (`spawn git ENOENT`, forever). It should still be
// surfaced as a warning so the operator can unregister/fix it.
import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { projects } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { scanDirtyMainCheckouts, resetMissingRepoScanCounts } from "../services/dirty-main-checkout.js";

describe("scanDirtyMainCheckouts — missing repoPath", () => {
  beforeEach(() => resetMissingRepoScanCounts());
  it("skips a project whose repoPath does not exist and surfaces it as a warning", async () => {
    const { db } = createTestDb();
    const missingPath = join(tmpdir(), `ak-missing-repo-${randomUUID()}`);
    await db.insert(projects).values({
      id: "proj-missing",
      name: "Ghost Project",
      repoPath: missingPath,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const warnings = await scanDirtyMainCheckouts(db);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      projectId: "proj-missing",
      repoPath: missingPath,
      fileCount: 0,
      files: [],
    });
    expect(warnings[0].message).toMatch(/no longer exists/i);
  });

  it("auto-archives a project after 3 consecutive missing-path scans (#271)", async () => {
    const { db } = createTestDb();
    const missingPath = join(tmpdir(), `ak-missing-repo-${randomUUID()}`);
    await db.insert(projects).values({
      id: "proj-dead",
      name: "Dead Project",
      repoPath: missingPath,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await scanDirtyMainCheckouts(db);
    await scanDirtyMainCheckouts(db);
    let [row] = await db.select({ archivedAt: projects.archivedAt }).from(projects).where(eq(projects.id, "proj-dead"));
    expect(row.archivedAt).toBeNull(); // two misses — not yet

    const warnings = await scanDirtyMainCheckouts(db); // third miss — archive
    [row] = await db.select({ archivedAt: projects.archivedAt }).from(projects).where(eq(projects.id, "proj-dead"));
    expect(row.archivedAt).not.toBeNull();
    expect(warnings[0].message).toMatch(/auto-archived/i);

    // Archived + missing: subsequent scans are silent — the churn ends here.
    const after = await scanDirtyMainCheckouts(db);
    expect(after).toHaveLength(0);
  });

  it("stays silent for an already-archived project with a missing path (#271)", async () => {
    const { db } = createTestDb();
    const missingPath = join(tmpdir(), `ak-missing-repo-${randomUUID()}`);
    await db.insert(projects).values({
      id: "proj-archived",
      name: "Archived Ghost",
      repoPath: missingPath,
      defaultBranch: "main",
      archivedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const warnings = await scanDirtyMainCheckouts(db);
    expect(warnings).toHaveLength(0);
  });
});
