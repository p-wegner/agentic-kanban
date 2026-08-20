/**
 * #242: an abandoned merge-queue stream must not leak the on-disk repo lock.
 *
 * `executeQueue` is an async GENERATOR. In its sequential path it acquires the on-disk repo lock,
 * then `yield`s several times (`rebasing`, `rebase_ok`, …) before releasing it. The SSE route
 * `break`s out of its loop when the client stream closes (and a `writeSSE` throw propagates the
 * same way), which calls the generator's `.return()` at the suspended yield — so every statement
 * after that yield, INCLUDING the release, never ran.
 *
 * The failure was permanent rather than self-healing: the heartbeat `setInterval` also survived,
 * so the lock never aged into staleness and its pid stayed alive, which means no recovery path in
 * `repo-lock.ts` applied. Closing the merge-queue tab while a member rebased blocked every
 * subsequent merge on that repo — manual, monitor, and train — until the server restarted.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { inspectRepoLock } from "@agentic-kanban/shared/lib/repo-lock";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

const mocks = vi.hoisted(() => ({
  mergeWorkspace: vi.fn(),
  rebaseOntoBase: vi.fn(),
  revParse: vi.fn(),
  isAncestor: vi.fn(),
  autoRenumberMigrations: vi.fn(),
  abortRebase: vi.fn(),
  detectConflicts: vi.fn(),
}));

vi.mock("../services/git.service.js", () => ({
  getChangedFileNames: vi.fn(() => Promise.resolve([] as string[])),
  getChangedFilesBetween: vi.fn(() => Promise.resolve([])),
  rebaseOntoBase: mocks.rebaseOntoBase,
  revParse: mocks.revParse,
  isAncestor: mocks.isAncestor,
  autoRenumberMigrations: mocks.autoRenumberMigrations,
  abortRebase: mocks.abortRebase,
  detectConflicts: mocks.detectConflicts,
}));

vi.mock("../services/workspace-merge.service.js", () => ({
  createWorkspaceMergeService: () => ({ mergeWorkspace: mocks.mergeWorkspace }),
}));

const { createMergeQueueService } = await import("../services/merge-queue.service.js");

/** A REAL repo directory: `tryAcquireRepoLock` refuses a repoPath with no `.git`, and the queue
 *  then polls for its full 90-minute budget instead of failing. */
const tempRepos: string[] = [];
function makeRepoPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "merge-queue-lock-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  tempRepos.push(dir);
  return dir;
}

async function seed(db: TestDb, repoPath: string) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Lock Leak Project",
    repoPath,
    repoName: "repo",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId,
    projectId,
    name: "In Review",
    sortOrder: 0,
    isDefault: true,
    createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 242,
    title: "Lock leak",
    priority: "medium",
    sortOrder: 0,
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-242-lock-leak",
    workingDir: join(repoPath, ".worktrees", "ws0"),
    baseBranch: "main",
    status: "idle",
    isDirect: false,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });
  return { workspaceId };
}

describe("merge-queue repo lock survives an abandoned stream (#242)", () => {
  beforeEach(() => {
    mocks.mergeWorkspace.mockReset().mockResolvedValue({ id: "x", mergeOutput: "ok" });
    mocks.rebaseOntoBase.mockReset().mockResolvedValue({ success: true });
    mocks.revParse.mockReset().mockResolvedValue("feature-sha");
    mocks.isAncestor.mockReset().mockResolvedValue(true);
    mocks.autoRenumberMigrations.mockReset().mockResolvedValue({ renumbered: false, renames: [] });
    mocks.abortRebase.mockReset().mockResolvedValue(undefined);
    mocks.detectConflicts.mockReset().mockResolvedValue({ hasConflicts: false, conflictingFiles: [] });
  });

  afterEach(() => {
    while (tempRepos.length) {
      try { rmSync(tempRepos.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("releases the lock when the consumer abandons the generator at a yield inside the locked region", async () => {
    const repoPath = makeRepoPath();
    const { db } = createTestDb();
    const { workspaceId } = await seed(db, repoPath);
    const service = createMergeQueueService({ database: db });

    // `break` on the FIRST event yielded from inside the locked region is exactly what the SSE
    // route does when the client stream closes — it calls the generator's `.return()`.
    let sawRebasing = false;
    for await (const event of service.executeQueue([workspaceId])) {
      if (event.type === "rebasing") {
        // The lock IS held at this point; that's the precondition the leak depended on.
        expect(inspectRepoLock(repoPath)).not.toBeNull();
        sawRebasing = true;
        break;
      }
    }
    expect(sawRebasing).toBe(true);

    // The decisive assertion: no lockfile survives the abandonment. (Before the fix this stayed
    // on disk with a live pid and a fresh heartbeat, so nothing could ever reclaim it.)
    expect(inspectRepoLock(repoPath)).toBeNull();

    // …and the repo is genuinely usable again: a fresh queue run completes.
    const events = [];
    for await (const event of service.executeQueue([workspaceId])) {
      events.push(event);
    }
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(inspectRepoLock(repoPath)).toBeNull();
  });

  it("releases the lock when the locked region THROWS rather than yielding to completion", async () => {
    const repoPath = makeRepoPath();
    const { db } = createTestDb();
    const { workspaceId } = await seed(db, repoPath);
    const service = createMergeQueueService({ database: db });

    // An unexpected (non-Error-handled) failure inside the locked region must not strand the lock
    // either — `finally` covers throw and `.return()` alike.
    mocks.rebaseOntoBase.mockRejectedValue(new Error("git exploded"));

    const events = [];
    for await (const event of service.executeQueue([workspaceId])) {
      events.push(event);
    }
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(inspectRepoLock(repoPath)).toBeNull();
  });
});
