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
import {
  findLiveWorktreeSharers,
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
