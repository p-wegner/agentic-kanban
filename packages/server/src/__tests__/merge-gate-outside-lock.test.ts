/**
 * The verify gate must run OUTSIDE the per-repo merge lock.
 *
 * The gate (verify_script — tests + build) runs 20-40 minutes on this repo; the git work the
 * lock guards takes seconds. While the gate ran INSIDE the lock, the lock was a repo-wide
 * throughput cap: one merge per gate duration, and a FAILING gate blocked every other
 * workspace for its full run while landing nothing (measured live: a 41-minute gate that then
 * failed, with three other workspaces sitting ready behind it).
 *
 * These tests pin the two properties that make the fix real, expressed as observable behaviour
 * rather than as internals:
 *   1. A merge whose gate is still running does NOT refuse a merge of a DIFFERENT workspace in
 *      the same repo with "a merge is already in progress".
 *   2. A merge whose gate FAILS never takes the lock at all, so the next workspace can merge
 *      immediately afterwards.
 *   3. A passing gate is not paid for twice — doMerge accepts the pre-lock proof instead of
 *      re-running it under the lock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";

/**
 * The repo lock is a real file at `<repoPath>/.git/agentic-kanban-merge.lock`, and
 * `acquireOnDiskRepoLock` polls FOREVER when it cannot be written. A repoPath that does not
 * exist on disk therefore hangs the merge rather than failing it — so these tests need a real
 * directory containing a real `.git`, not a synthetic "/repo" string.
 */
const tempRepos: string[] = [];
function makeRepoPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "gate-lock-repo-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  tempRepos.push(dir);
  return dir;
}

/**
 * Controls what the (stubbed) gate does. Replaced per-test.
 *
 * We stub `resolveMergeGate` rather than the verify script itself because the real gate shells
 * out to `verify_script`; the token semantics it owns are re-implemented faithfully here so the
 * already-passed path under test is still exercised end-to-end.
 */
let gateBehaviour: () => Promise<{ passed: boolean; ran: boolean; stage: string; message: string }>;
const gateCalls: string[] = [];

vi.mock("../services/pre-merge-gate.service.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveMergeGate: vi.fn(async ({ token }: { token: { kind: string; evidence?: { stage: string } } }) => {
      gateCalls.push(token.kind);
      if (token.kind === "already-passed") {
        return {
          passed: true,
          ran: false,
          stage: token.evidence?.stage ?? "verify",
          message: "pre-merge gate already passed (proof)",
          decision: "already-passed",
        };
      }
      if (token.kind === "skip-explicit") {
        return { passed: true, ran: false, stage: "none", message: "skipped", decision: "skip-explicit" };
      }
      const result = await gateBehaviour();
      return { ...result, decision: "run-gate" };
    }),
  };
});

const { createWorkspaceMergeService } = await import("../services/workspace-merge.service.js");

/**
 * Stateful git double: a branch is NOT an ancestor of master until `mergeBranch` lands it, and
 * IS afterwards. A constant `false` trips the post-merge ancestry invariant; a constant `true`
 * makes every merge short-circuit as already-merged. Both hide the code path under test.
 */
function makeGit() {
  const merged = new Set<string>();
  const isMerged = (branch: string) => merged.has(branch);
  return {
    getDiff: vi.fn(async () => ""),
    getDiffFromRepo: vi.fn(async () => ""),
    revParse: vi.fn(async () => "some-sha"),
    isAncestor: vi.fn(async (_repo: string, branch: string) => isMerged(branch)),
    mergeBranch: vi.fn(async (_repo: string, branch: string) => {
      merged.add(branch);
      return "Merge made by the 'ort' strategy.";
    }),
    detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
    syncBranchToHead: vi.fn(async () => false),
    removeWorktree: vi.fn(async () => {}),
    deleteBranch: vi.fn(async () => {}),
    getChangedFilesBetween: vi.fn(async () => []),
    getCurrentBranch: vi.fn(async () => "master"),
    autoRenumberMigrations: vi.fn(async () => ({ renumbered: false, renames: [] })),
    checkBranchTipIsAncestor: vi.fn(async (_repo: string, branch: string) => ({
      isAncestor: isMerged(branch),
      branchSha: "feature-sha",
      baseSha: "master-sha",
    })),
    getUncommittedTrackedChanges: vi.fn(async () => []),
    countUniqueCommits: vi.fn(async () => 1),
    rebaseOntoBase: vi.fn(async () => ({ success: true })),
    mergeBaseIntoBranch: vi.fn(async () => ({ success: true })),
  };
}

/** Seed a project plus N workspaces that all share ONE repoPath (so they contend for one lock). */
async function seedRepoWithWorkspaces(
  db: ReturnType<typeof createTestDb>["db"],
  count: number,
  repoPath: string,
) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inReviewStatusId = randomUUID();
  const doneStatusId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Gate Lock Project",
    repoPath,
    repoName: "repo",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
    { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
  ]);

  const workspaceIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      issueNumber: 900 + i,
      title: `Gate lock issue ${i}`,
      priority: "medium",
      sortOrder: i,
      statusId: inReviewStatusId,
      projectId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      issueId,
      branch: `feature/ak-90${i}-gate-lock`,
      workingDir: `${repoPath}/.worktrees/ws${i}`,
      baseBranch: "master",
      isDirect: false,
      status: "idle",
      readyForMerge: true,
      mergedAt: null,
      provider: "claude",
      createdAt: now,
      updatedAt: now,
    });
    workspaceIds.push(workspaceId);
  }
  return { projectId, workspaceIds };
}

function makeService(db: ReturnType<typeof createTestDb>["db"]) {
  return createWorkspaceMergeService({
    database: db,
    gitService: makeGit() as never,
    createBackup: async () => {},
    processKiller: async () => 0,
  });
}

/** A promise plus its resolver, so a test can hold the gate open deterministically. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("verify gate runs outside the repo merge lock", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
    gateCalls.length = 0;
    gateBehaviour = async () => ({ passed: true, ran: true, stage: "verify", message: "ok" });
  });

  afterEach(() => {
    while (tempRepos.length) {
      try { rmSync(tempRepos.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("a merge stuck in its gate does not refuse a different workspace in the same repo", async () => {
    const repoPath = makeRepoPath();
    const { workspaceIds } = await seedRepoWithWorkspaces(db, 2, repoPath);
    const svc = makeService(db);

    // Hold workspace A's gate open, exactly like a 40-minute verify run.
    const held = deferred<void>();
    let gateEntries = 0;
    gateBehaviour = async () => {
      gateEntries++;
      if (gateEntries === 1) await held.promise;
      return { passed: true, ran: true, stage: "verify", message: "ok" };
    };

    const mergeA = svc.mergeWorkspace(workspaceIds[0]);
    // Let A reach its gate.
    await vi.waitFor(() => expect(gateEntries).toBe(1));

    // B must NOT be refused: A holds no lock while it is merely gating.
    const mergeB = svc.mergeWorkspace(workspaceIds[1]);
    await vi.waitFor(() => expect(gateEntries).toBe(2));

    held.resolve();
    await expect(mergeA).resolves.toBeDefined();
    await expect(mergeB).resolves.toBeDefined();
  });

  it("a failing gate never takes the lock, so the next workspace merges immediately", async () => {
    const repoPath = makeRepoPath();
    const { workspaceIds } = await seedRepoWithWorkspaces(db, 2, repoPath);
    const svc = makeService(db);

    gateBehaviour = async () => ({ passed: false, ran: true, stage: "verify", message: "verify_script failed (exit 1)" });
    await expect(svc.mergeWorkspace(workspaceIds[0])).rejects.toThrow(/Pre-merge gate failed/i);

    // The decisive assertion: the failure must NOT have left a lock behind. A second workspace
    // merges right away rather than hitting "a merge is already in progress".
    gateBehaviour = async () => ({ passed: true, ran: true, stage: "verify", message: "ok" });
    await expect(svc.mergeWorkspace(workspaceIds[1])).resolves.toBeDefined();
  });

  it("a passing gate is paid for once — doMerge accepts the pre-lock proof", async () => {
    const repoPath = makeRepoPath();
    const { workspaceIds } = await seedRepoWithWorkspaces(db, 1, repoPath);
    const svc = makeService(db);

    let expensiveRuns = 0;
    gateBehaviour = async () => {
      expensiveRuns++;
      return { passed: true, ran: true, stage: "verify", message: "ok" };
    };

    await expect(svc.mergeWorkspace(workspaceIds[0])).resolves.toBeDefined();

    // Gate consulted twice (pre-lock, then under the lock) but only RUN once: the second
    // consultation is satisfied by the already-passed proof.
    expect(expensiveRuns).toBe(1);
    expect(gateCalls).toEqual(["run-gate", "already-passed"]);
  });
});
