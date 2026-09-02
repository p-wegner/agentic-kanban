/**
 * #998 — the map refresh must not commit to a project's main checkout while a merge is in flight
 * for that project.
 *
 * A pre-merge gate records the base tip when it starts and runs for 6-40 minutes. A commit landing
 * in that window moves the tip, and #243 correctly DISCARDS the verdict — the whole run is thrown
 * away. #993 made this reachable by registering the map reconciler in `BACKGROUND_SERVICES`, where
 * it commits `docs/tests/impact-map.json` every 15 minutes independently of anything the merge
 * path knows.
 *
 * Measured on this board 2026-09-01, with #979's sha-naming instrumentation:
 *
 *   [merge-gate] workspace 42eb8b43-...: gate attempt 1 (pre-lock-merge) PASSED after 590s
 *     but its verdict is DISCARDED — base f805f608 -> a0881bf8 moved during the run (#243)
 *
 * where `a0881bf807` is `chore: rebuild test-impact map @ 00ed5ddeb3` — the pass's own commit.
 *
 * The predicate is the #945 in-flight marker, which spans the whole gate including verification.
 * The `lock_busy` skip the pass already had does NOT cover this: the repo lock is held by the
 * merge, and the gate runs before it (the discarded attempt is named `pre-lock-merge`).
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
  // project is enabled so the ONLY thing that can skip one is the merge deferral under test.
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
  // `ak-` prefix, not `ak998-`: the reaper's swept namespace is what stops a failed teardown
  // leaking the dir permanently (#839/#840), and `temp-dir-namespace-guard` enforces it.
  const repoPath = mkdtempSync(join(tmpdir(), `ak-998-${name}-`));
  tempRoots.push(repoPath);
  await db.insert(projects).values({
    id: projectId, name, repoPath, repoName: name,
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 998, title: `${name} ticket`, priority: "medium",
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

describe("#998: the map refresh defers while a merge is in flight", () => {
  beforeEach(() => {
    runTestImpactMapPass.mockReset().mockResolvedValue({ outcome: "fresh" });
  });

  it("skips the project whose merge is running, and refreshes the others", async () => {
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
    // Per PROJECT, not board-wide: a busy project must not starve an idle one's map, which would
    // re-create the #993 defect (a map that rots forever) through a different door.
    expect(paths).toContain(idle.repoPath);
    expect(paths).not.toContain(merging.repoPath);
    // Said out loud. #993 exists because a map that never refreshed looked exactly like one that
    // did; a silent skip would be the same defect wearing a different hat.
    expect(logs.join(" ")).toContain("deferred");
    expect(logs.join(" ")).toContain(merging.projectId);
  });

  it("refreshes normally once the marker is gone", async () => {
    const project = await seedProject(`cleared-${randomUUID().slice(0, 6)}`);
    await setMergeRun(project.workspaceId, { jobId: "merge-2", startedAt: new Date().toISOString() });

    await runTestImpactMapRefresh(PREFS, { allowProject: () => true });
    expect(refreshedRepoPaths()).not.toContain(project.repoPath);

    // The marker is DELETED on every terminal transition (#945) — an absent row is "no merge in
    // flight", so the deferral has to lift on its own with no second signal to reset.
    const { clearMergeRun } = await import("../repositories/merge-run.repository.js");
    await clearMergeRun(project.workspaceId);
    runTestImpactMapPass.mockClear();

    await runTestImpactMapRefresh(PREFS, { allowProject: () => true });
    expect(refreshedRepoPaths()).toContain(project.repoPath);
  });
});
