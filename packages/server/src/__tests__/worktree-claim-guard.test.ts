// @covers workspaces.worktree-claim.guard [error]
//
// #713 — the ONE guard that answers "does a live workspace still claim this directory?".
//
// Three fixes in the 2026-08-20/21 wave each landed the same check at one call site of N:
// #699's `isPathClaimed` (1 of 8), #673's co-residency sharer check (1 of 5), and
// `a2efe48691`'s closed-sharer correction (1 of 2, both spelling the terminal status as the
// literal `"closed"`). `shared/lib/worktree-claim.ts` is the consolidation; this suite pins
// the BEHAVIOUR every one of those call sites now inherits, so a future call site gets the
// same answers by construction rather than by a re-read of the guard.
//
// The bias is deliberate and asymmetric: a wrong "claimed" costs a refused cleanup (a human
// or the next pass redoes it); a wrong "not claimed" recursively deletes a worktree an agent
// is working in. Every ambiguity below therefore asserts REFUSAL.
import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { cleanupMergedWorktreeAndBranch } from "../services/merge-executor.service.js";
import type { GitService } from "../services/workspace-internals.js";
import {
  findLiveWorktreeSharers,
  findLiveBranchHolders,
  removeWorktreeUnlessShared,
  resolveWorktreeClaims,
} from "@agentic-kanban/shared/lib/worktree-claim";

async function seedIssue(db: TestDb): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: "/tmp/claim-repo", repoName: "claim-repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 1, title: "T", statusId, projectId,
    createdAt: now, updatedAt: now,
  });
  return issueId;
}

async function seedWorkspace(
  db: TestDb,
  issueId: string,
  status: string,
  workingDir: string | null,
): Promise<string> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(workspaces).values({
    id, issueId, branch: `feature/${id.slice(0, 6)}`, status,
    workingDir, isDirect: false, createdAt: now, updatedAt: now,
  });
  return id;
}

/** A database whose reads throw — the "DB hiccup" every one of these guards swallowed. */
function brokenDb(): TestDb {
  return {
    select: () => {
      throw new Error("database is locked");
    },
  } as unknown as TestDb;
}

describe("resolveWorktreeClaims — the createWorktree leftover-delete guard", () => {
  it("claims a directory a NON-TERMINAL workspace names, and only that one", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    await seedWorkspace(db, issueId, "active", "/tmp/claim-repo/.worktrees/ak-1");

    const { isPathClaimed } = await resolveWorktreeClaims(db);

    expect(isPathClaimed("/tmp/claim-repo/.worktrees/ak-1")).toBe(true);
    expect(isPathClaimed("/tmp/claim-repo/.worktrees/ak-2")).toBe(false);
  });

  it("does NOT claim a terminal workspace's directory — the cleanup exists for exactly that", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    await seedWorkspace(db, issueId, "closed", "/tmp/claim-repo/.worktrees/ak-3");

    const { isPathClaimed } = await resolveWorktreeClaims(db);

    expect(isPathClaimed("/tmp/claim-repo/.worktrees/ak-3")).toBe(false);
  });

  it("claims an `error`-status workspace's directory — non-terminal still holds a worktree", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    await seedWorkspace(db, issueId, "error", "/tmp/claim-repo/.worktrees/ak-4");

    const { isPathClaimed } = await resolveWorktreeClaims(db);

    expect(isPathClaimed("/tmp/claim-repo/.worktrees/ak-4")).toBe(true);
  });

  it("matches on the canonical path, so a separator/casing variant is not a miss", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    await seedWorkspace(db, issueId, "active", "C:\\tmp\\claim-repo\\.worktrees\\ak-5");

    const { isPathClaimed } = await resolveWorktreeClaims(db);

    // An `eq(workingDir, ...)` query would answer "not claimed" here, which is the
    // unrecoverable direction.
    expect(isPathClaimed("C:/tmp/claim-repo/.worktrees/ak-5")).toBe(true);
  });

  it("FAILS CLOSED: a broken read claims every path rather than green-lighting the delete", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { isPathClaimed } = await resolveWorktreeClaims(brokenDb());
      expect(isPathClaimed("/anything/at/all")).toBe(true);
      expect(isPathClaimed("")).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("removeWorktreeUnlessShared — the co-residency delete guard", () => {
  it("removes when nobody else shares the directory", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    const id = await seedWorkspace(db, issueId, "closed", "/tmp/claim-repo/.worktrees/ak-10");
    const removeWorktree = vi.fn(async () => {});

    const outcome = await removeWorktreeUnlessShared({
      database: db, workingDir: "/tmp/claim-repo/.worktrees/ak-10",
      workspaceId: id, label: "test", removeWorktree,
    });

    expect(outcome.removed).toBe(true);
    expect(removeWorktree).toHaveBeenCalledOnce();
  });

  it("REFUSES when a live workspace co-resides — co-residency is a supported state (#394)", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    const dir = "/tmp/claim-repo/.worktrees/ak-11";
    const id = await seedWorkspace(db, issueId, "closed", dir);
    await seedWorkspace(db, issueId, "active", dir);
    const removeWorktree = vi.fn(async () => {});

    const outcome = await removeWorktreeUnlessShared({
      database: db, workingDir: dir, workspaceId: id, label: "test", removeWorktree,
    });

    expect(outcome).toMatchObject({ removed: false, reason: "shared" });
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("a CLOSED co-resident does not block the removal — the bare `length > 0` bug", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    const dir = "/tmp/claim-repo/.worktrees/ak-12";
    const id = await seedWorkspace(db, issueId, "closed", dir);
    await seedWorkspace(db, issueId, "closed", dir);
    const removeWorktree = vi.fn(async () => {});

    const outcome = await removeWorktreeUnlessShared({
      database: db, workingDir: dir, workspaceId: id, label: "test", removeWorktree,
    });

    expect(outcome.removed).toBe(true);
  });

  it("an `error`-status co-resident DOES block it — non-terminal is live", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    const dir = "/tmp/claim-repo/.worktrees/ak-13";
    const id = await seedWorkspace(db, issueId, "closed", dir);
    await seedWorkspace(db, issueId, "error", dir);

    const outcome = await removeWorktreeUnlessShared({
      database: db, workingDir: dir, workspaceId: id, label: "test",
      removeWorktree: vi.fn(async () => {}),
    });

    expect(outcome).toMatchObject({ removed: false, reason: "shared" });
  });

  it("FAILS CLOSED: a broken sharer query refuses instead of removing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const removeWorktree = vi.fn(async () => {});
      const outcome = await removeWorktreeUnlessShared({
        database: brokenDb(), workingDir: "/tmp/claim-repo/.worktrees/ak-14",
        workspaceId: "x", label: "test", removeWorktree,
      });
      expect(outcome).toMatchObject({ removed: false, reason: "claim-check-failed" });
      expect(removeWorktree).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("reports a failed removal as such, rather than throwing at the caller", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    const dir = "/tmp/claim-repo/.worktrees/ak-15";
    const id = await seedWorkspace(db, issueId, "closed", dir);

    const outcome = await removeWorktreeUnlessShared({
      database: db, workingDir: dir, workspaceId: id, label: "test",
      removeWorktree: async () => { throw new Error("EBUSY"); },
    });

    expect(outcome).toMatchObject({ removed: false, reason: "remove-failed" });
  });

  it("never counts the workspace itself as its own sharer", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    const dir = "/tmp/claim-repo/.worktrees/ak-16";
    const id = await seedWorkspace(db, issueId, "active", dir);

    expect(await findLiveWorktreeSharers(db, dir, { excludeWorkspaceId: id })).toHaveLength(0);
    expect(await findLiveWorktreeSharers(db, dir)).toHaveLength(1);
  });
});

/**
 * #735 — the branch-keyed half of the claim question, absorbed from
 * `startup/orphaned-worktree-reconciler.ts` when its removal was routed through this guard.
 *
 * That reconciler's own analysis was STRONGER than this module's on exactly one point, and
 * it is the unrecoverable direction: finishing a merge NULLS `workspaces.working_dir`
 * (`finalizeMergeCleanup` → `clearWorkspaceWorkingDir`), so a live workspace can hold a
 * worktree that no row names by PATH. `findLiveWorktreeSharers` sees nothing there. Rather
 * than leave that reasoning in a second file — the drift this module exists to end — it lives
 * here as an OPTIONAL `branch` argument, so the guard is a superset of the reconciler's rules
 * and the callers that delete a directory their own row still names are untouched.
 */
describe("removeWorktreeUnlessShared — the branch-keyed claim (#735)", () => {
  async function seedOnBranch(db: TestDb, issueId: string, status: string, workingDir: string | null, branch: string): Promise<string> {
    const now = new Date().toISOString();
    const id = randomUUID();
    await db.insert(workspaces).values({
      id, issueId, branch, status, workingDir, isDirect: false, createdAt: now, updatedAt: now,
    });
    return id;
  }

  it("REFUSES when a LIVE workspace holds the branch, even though no row names the path", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    await seedOnBranch(db, issueId, "active", null, "feature/ak-42-live");
    const removeWorktree = vi.fn(async () => {});

    const outcome = await removeWorktreeUnlessShared({
      database: db, workingDir: "/tmp/claim-repo/.worktrees/ak-42",
      branch: "feature/ak-42-live", label: "test", removeWorktree,
    });

    expect(outcome).toMatchObject({ removed: false, reason: "branch-claimed" });
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("does NOT refuse for a TERMINAL branch holder — that is the #361 orphan being swept", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    await seedOnBranch(db, issueId, "closed", null, "feature/ak-43-merged");
    const removeWorktree = vi.fn(async () => {});

    const outcome = await removeWorktreeUnlessShared({
      database: db, workingDir: "/tmp/claim-repo/.worktrees/ak-43",
      branch: "feature/ak-43-merged", label: "test", removeWorktree,
    });

    expect(outcome.removed).toBe(true);
  });

  it("is INERT when no branch is passed — the six #713 call sites keep their exact behaviour", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    await seedOnBranch(db, issueId, "active", null, "feature/ak-44-live");
    const removeWorktree = vi.fn(async () => {});

    const outcome = await removeWorktreeUnlessShared({
      database: db, workingDir: "/tmp/claim-repo/.worktrees/ak-44", label: "test", removeWorktree,
    });

    expect(outcome.removed).toBe(true);
  });

  it("never counts the workspace itself as its own branch holder", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    const id = await seedOnBranch(db, issueId, "active", null, "feature/ak-45-self");

    expect(await findLiveBranchHolders(db, "feature/ak-45-self", { excludeWorkspaceId: id })).toHaveLength(0);
    expect(await findLiveBranchHolders(db, "feature/ak-45-self")).toHaveLength(1);
  });

  it("an EMPTY branch matches nothing — a detached HEAD is not claimed by every blank row", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    await seedOnBranch(db, issueId, "active", null, "");

    expect(await findLiveBranchHolders(db, "")).toHaveLength(0);
    expect(await findLiveBranchHolders(db, "   ")).toHaveLength(0);
  });

  it("FAILS CLOSED: a broken branch read refuses instead of removing", async () => {
    const removeWorktree = vi.fn(async () => {});
    // The path query must succeed and the BRANCH query fail, so the refusal is provably the
    // branch check's. `selectWorkingDirClaims` filters `isNotNull(working_dir)` in memory,
    // so a row set with no workingDir answers the first query with "no sharers".
    let call = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: async () => {
            call += 1;
            if (call === 1) return [];
            throw new Error("database is locked");
          },
        }),
      }),
    } as unknown as TestDb;

    const outcome = await removeWorktreeUnlessShared({
      database: db, workingDir: "/tmp/claim-repo/.worktrees/ak-46",
      branch: "feature/ak-46", label: "test", removeWorktree,
    });

    expect(outcome).toMatchObject({ removed: false, reason: "claim-check-failed" });
    expect(outcome).toHaveProperty("message", expect.stringContaining("holds branch feature/ak-46"));
    expect(removeWorktree).not.toHaveBeenCalled();
  });
});

/**
 * #859 — two claims the guard could not see, both taken from a real incident: the orphaned-
 * worktree reconciler deleted a worktree while (a) a workspace row pointed at exactly that
 * workingDir and (b) its 48s provisioning was still in flight.
 */
describe("removeWorktreeUnlessShared — any-row and in-flight-provisioning claims (#859)", () => {
  it("with treatAnyRowAsClaim, a row in ANY state naming the path refuses the removal", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    const dir = "/tmp/claim-repo/.worktrees/ak-59";
    // Closed — invisible to the live-sharers check, but it still NAMES the path.
    await seedWorkspace(db, issueId, "closed", dir);
    const removeWorktree = vi.fn(async () => {});

    const outcome = await removeWorktreeUnlessShared({
      database: db, workingDir: dir, treatAnyRowAsClaim: true, label: "test", removeWorktree,
    });

    expect(outcome).toMatchObject({ removed: false, reason: "named-by-row" });
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("treatAnyRowAsClaim still excludes the workspace's OWN row, so self-cleanup keeps working", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    const dir = "/tmp/claim-repo/.worktrees/ak-60";
    const id = await seedWorkspace(db, issueId, "closed", dir);

    const outcome = await removeWorktreeUnlessShared({
      database: db, workingDir: dir, workspaceId: id, treatAnyRowAsClaim: true,
      label: "test", removeWorktree: vi.fn(async () => {}),
    });

    expect(outcome.removed).toBe(true);
  });

  it("REFUSES while an in-flight create (live #630 marker) names the path — no workspace row exists yet", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    const dir = "/tmp/claim-repo/.worktrees/ak-61";
    const { workspaceProvisioning, issues: issuesTable } = await import("@agentic-kanban/shared/schema");
    const { eq } = await import("drizzle-orm");
    const [issueRow] = await db.select({ projectId: issuesTable.projectId }).from(issuesTable).where(eq(issuesTable.id, issueId));
    await db.insert(workspaceProvisioning).values({
      id: randomUUID(), issueId, projectId: issueRow.projectId, branch: "feature/ak-61",
      worktreePath: dir, serverPid: process.pid, phase: "siblings", startedAt: new Date().toISOString(),
    });
    const removeWorktree = vi.fn(async () => {});

    const outcome = await removeWorktreeUnlessShared({
      database: db, workingDir: dir, label: "test", removeWorktree,
    });

    expect(outcome).toMatchObject({ removed: false, reason: "provisioning" });
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("also claims by the marker's BRANCH before the worktree path is recorded", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    const { workspaceProvisioning, issues: issuesTable } = await import("@agentic-kanban/shared/schema");
    const { eq } = await import("drizzle-orm");
    const [issueRow] = await db.select({ projectId: issuesTable.projectId }).from(issuesTable).where(eq(issuesTable.id, issueId));
    await db.insert(workspaceProvisioning).values({
      id: randomUUID(), issueId, projectId: issueRow.projectId, branch: "feature/ak-62",
      worktreePath: null, serverPid: process.pid, phase: "worktree", startedAt: new Date().toISOString(),
    });

    const outcome = await removeWorktreeUnlessShared({
      database: db, workingDir: "/tmp/claim-repo/.worktrees/ak-62", branch: "feature/ak-62",
      label: "test", removeWorktree: vi.fn(async () => {}),
    });

    expect(outcome).toMatchObject({ removed: false, reason: "provisioning" });
  });

  it("a DEAD process's marker is NOT a claim — crashed-create debris stays removable", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    const dir = "/tmp/claim-repo/.worktrees/ak-63";
    const { workspaceProvisioning, issues: issuesTable } = await import("@agentic-kanban/shared/schema");
    const { eq } = await import("drizzle-orm");
    const [issueRow] = await db.select({ projectId: issuesTable.projectId }).from(issuesTable).where(eq(issuesTable.id, issueId));
    await db.insert(workspaceProvisioning).values({
      id: randomUUID(), issueId, projectId: issueRow.projectId, branch: "feature/ak-63",
      worktreePath: dir, serverPid: 999_999_999, phase: "siblings", startedAt: new Date().toISOString(),
    });
    const removeWorktree = vi.fn(async () => {});

    const outcome = await removeWorktreeUnlessShared({
      database: db, workingDir: dir, label: "test", removeWorktree,
    });

    expect(outcome.removed).toBe(true);
    expect(removeWorktree).toHaveBeenCalledOnce();
  });
});

describe("cleanupMergedWorktreeAndBranch — the post-merge delete path (#673 at 1 of 5)", () => {
  function fakeGit(): GitService {
    return {
      removeWorktree: vi.fn(async () => {}),
      deleteBranch: vi.fn(async () => {}),
    } as unknown as GitService;
  }

  it("does NOT remove the worktree when a live workspace co-resides in it", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    const dir = "/tmp/claim-repo/.worktrees/ak-20";
    const mergedId = await seedWorkspace(db, issueId, "closed", dir);
    await seedWorkspace(db, issueId, "active", dir);
    const gitService = fakeGit();
    const onRemoveWorktreeError = vi.fn();

    await cleanupMergedWorktreeAndBranch({
      repoPath: "/tmp/claim-repo",
      workingDir: dir,
      branch: "feature/ak-20",
      gitService,
      database: db,
      workspaceId: mergedId,
      onRemoveWorktreeError,
    });

    expect(gitService.removeWorktree).not.toHaveBeenCalled();
    // The refusal is REPORTED, not swallowed — it reaches the caller's warning hook.
    expect(onRemoveWorktreeError).toHaveBeenCalledOnce();
    // The branch delete is unaffected: it is not the co-resident's resource.
    expect(gitService.deleteBranch).toHaveBeenCalledOnce();
  });

  it("removes the worktree when the only other sharer is terminal", async () => {
    const { db } = createTestDb();
    const issueId = await seedIssue(db);
    const dir = "/tmp/claim-repo/.worktrees/ak-21";
    const mergedId = await seedWorkspace(db, issueId, "closed", dir);
    await seedWorkspace(db, issueId, "closed", dir);
    const gitService = fakeGit();
    const onRemoveWorktreeError = vi.fn();

    await cleanupMergedWorktreeAndBranch({
      repoPath: "/tmp/claim-repo",
      workingDir: dir,
      branch: "feature/ak-21",
      gitService,
      database: db,
      workspaceId: mergedId,
      onRemoveWorktreeError,
    });

    expect(gitService.removeWorktree).toHaveBeenCalledOnce();
    expect(onRemoveWorktreeError).not.toHaveBeenCalled();
  });
});
