/**
 * #1018 — the map refresh does not commit, so it no longer defers around a merge.
 *
 * ## What this file used to assert, and why it was inverted rather than deleted
 *
 * It was `test-impact-map-merge-deferral.test.ts` (#998). The pass COMMITTED the rebuilt map, and
 * a commit landing on master moves the base tip under every running pre-merge gate — #243 then
 * correctly DISCARDS that gate's verdict. Measured on this board 2026-09-01:
 *
 *   [merge-gate] workspace 42eb8b43-...: gate attempt 1 (pre-lock-merge) PASSED after 590s
 *     but its verdict is DISCARDED — base f805f608 -> a0881bf8 moved during the run (#243)
 *
 * where `a0881bf807` was `chore: rebuild test-impact map @ 00ed5ddeb3` — the pass's own commit.
 * #998's answer was to skip any project with an in-flight merge (the #945 marker).
 *
 * #1018 removed the commit instead: the map is a gitignored artifact rebuilt in place, and the
 * worktree a gate runs in holds its own snapshot copy. There is no base movement to defer around
 * and no way for a rebuild to change what a running gate selects. The deferral was therefore pure
 * cost — a busy project's map would stop refreshing, which is precisely the #993 rot — so it is
 * gone, and this file pins its ABSENCE. The fixture is kept because the thing worth guarding is
 * that the in-flight marker no longer influences the pass at all; a deleted file would guard
 * nothing, and the deferral is exactly the kind of defensive skip that gets re-added by someone
 * reading #998's commit message without #1018's.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";

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

const { runTestImpactMapPass } = vi.hoisted(() => ({ runTestImpactMapPass: vi.fn() }));
vi.mock("../services/test-impact-map.service.js", () => ({
  runTestImpactMapPass,
  // The per-project opt-out is a different question (#993) and has its own tests; here every
  // project is enabled so nothing but the code under test can skip one.
  resolveTestImpactMapGate: () => ({ enabled: true }),
}));

import { db } from "../db/index.js";
import { runTestImpactMapRefresh } from "../startup/monitor-test-impact-map.js";
import { setMergeRun } from "../repositories/merge-run.repository.js";

const PREFS = new Map([["test_impact_map_refresh", "true"]]);

const tempRoots: string[] = [];
afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

/**
 * A project with one status (so `listBoardProjectIds` sees it) and one workspace on one issue.
 *
 * The repo path must EXIST: the refresh skips a project whose checkout is gone, and a fixture
 * pointing at a non-existent path would make every assertion below pass for the wrong reason.
 */
async function seedProject(name: string): Promise<{ projectId: string; workspaceId: string; repoPath: string }> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  // `ak-` prefix, not `ak1018-`: the reaper's swept namespace is what stops a failed teardown
  // leaking the dir permanently (#839/#840), and `temp-dir-namespace-guard` enforces it.
  const repoPath = mkdtempSync(join(tmpdir(), `ak-1018-${name}-`));
  tempRoots.push(repoPath);
  await db.insert(projects).values({
    id: projectId, name, repoPath, repoName: name,
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 1018, title: `${name} ticket`, priority: "medium",
    sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: `feature/${name}`, workingDir: null, baseBranch: "master",
    isDirect: false, status: "idle", readyForMerge: true, provider: "claude",
    createdAt: now, updatedAt: now,
  });
  return { projectId, workspaceId, repoPath };
}

/** Which repo paths the pass was actually invoked for. */
function refreshedRepoPaths(): string[] {
  return runTestImpactMapPass.mock.calls.map((call) => String(call[0]));
}

describe("#1018: the map refresh no longer defers around a merge", () => {
  beforeEach(() => {
    runTestImpactMapPass.mockReset().mockResolvedValue({ outcome: "fresh" });
  });

  it("refreshes a project WHILE its merge is in flight, and says nothing about deferring", async () => {
    const merging = await seedProject(`merging-${randomUUID().slice(0, 6)}`);
    const idle = await seedProject(`idle-${randomUUID().slice(0, 6)}`);
    await setMergeRun(merging.workspaceId, { jobId: "merge-1", startedAt: new Date().toISOString(), source: "merge-endpoint" });

    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((m: unknown) => { logs.push(String(m)); });
    try {
      await runTestImpactMapRefresh(PREFS, { allowProject: () => true });
    } finally {
      log.mockRestore();
    }

    const paths = refreshedRepoPaths();
    expect(paths).toContain(idle.repoPath);
    // The inversion. Under #998 this project was skipped; the pass now commits nothing, so there
    // is no base to move and the busiest project's map keeps up like every other one's.
    expect(paths).toContain(merging.repoPath);
    expect(logs.join(" ")).not.toContain("deferred");
  });

  it("reads no merge state at all — the marker is not an input to this pass any more", async () => {
    // Stronger than "it refreshed anyway": the in-flight row is set and then cleared, and the
    // pass behaves identically across both. A reintroduced skip would show up as a difference.
    const project = await seedProject(`marker-${randomUUID().slice(0, 6)}`);
    await setMergeRun(project.workspaceId, { jobId: "merge-2", startedAt: new Date().toISOString() });

    await runTestImpactMapRefresh(PREFS, { allowProject: () => true });
    expect(refreshedRepoPaths()).toContain(project.repoPath);

    const { clearMergeRun } = await import("../repositories/merge-run.repository.js");
    await clearMergeRun(project.workspaceId);
    runTestImpactMapPass.mockClear();

    await runTestImpactMapRefresh(PREFS, { allowProject: () => true });
    expect(refreshedRepoPaths()).toContain(project.repoPath);
  });

  it("still says out loud when a checkout is inert because it TRACKS the map", async () => {
    // The one skip that survives is not a deferral but a one-time operator action. #993 exists
    // because a map that never refreshed looked exactly like one that did, so this must be loud.
    const project = await seedProject(`tracked-${randomUUID().slice(0, 6)}`);
    runTestImpactMapPass.mockResolvedValue({
      outcome: "map_tracked",
      detail: "docs/tests/impact-map.json is still tracked in this checkout — `git rm --cached` it once (#1018)",
    });

    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((m: unknown) => { warnings.push(String(m)); });
    try {
      await runTestImpactMapRefresh(PREFS, { allowProject: () => true });
    } finally {
      warn.mockRestore();
    }

    expect(warnings.join(" ")).toContain(project.projectId);
    expect(warnings.join(" ")).toContain("git rm --cached");
  });
});
