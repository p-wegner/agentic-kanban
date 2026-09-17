// #1192 — sidings: a merge-train member dropped for a conflict gets a rebase turn (409-safe)
// and is held out of the train's candidate set until its branch tip actually moves, instead of
// being released straight back into the same conflict every window.
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issueComments, issueTags, projects, projectStatuses, issues, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  TRAIN_SIDING_MAX_ATTEMPTS,
  TRAIN_SIDING_TAG,
  clearTrainSiding,
  isSidingDrop,
  isStillSided,
  isSidingCapped,
  partitionSidedMembers,
  recordTrainSidingDrop,
} from "../services/merge-train-siding.service.js";
import { getTrainSidingState } from "../repositories/merge-train-siding.repository.js";

const T0 = "2026-09-17T00:00:00.000Z";

type Db = ReturnType<typeof createTestDb>["db"];

async function seedMember(db: Db, branch = "feature/ak-1"): Promise<{ workspaceId: string; issueId: string }> {
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: T0, updatedAt: T0,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: T0,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 1, title: "Issue 1", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: T0, updatedAt: T0,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch, workingDir: "/repo/.worktrees/ws",
    baseBranch: "master", status: "idle", provider: "claude", createdAt: T0, updatedAt: T0,
  });
  return { workspaceId, issueId };
}

describe("isStillSided (#1192)", () => {
  it("is false with no row, no sha, or an unchanged-tip mismatch", () => {
    expect(isStillSided(undefined, "sha1")).toBe(false);
    expect(isStillSided({ sidedBranchSha: "sha1" }, null)).toBe(false);
    expect(isStillSided({ sidedBranchSha: null }, "sha1")).toBe(false);
  });

  it("is true only when the recorded sha still matches the current tip", () => {
    expect(isStillSided({ sidedBranchSha: "sha1" }, "sha1")).toBe(true);
    expect(isStillSided({ sidedBranchSha: "sha1" }, "sha2")).toBe(false);
  });
});

describe("isSidingDrop", () => {
  it("sides a rebase-needed drop but never a deferred (#1191 member-vs-member) one", () => {
    expect(isSidingDrop({ reason: "Merge conflict in: src/foo.ts" })).toBe(true);
    expect(isSidingDrop({ reason: "conflicts with feature/ak-2 (#2) — deferred to the next train", deferred: true })).toBe(false);
  });
});

describe("isSidingCapped", () => {
  it("reads cappedAt presence", () => {
    expect(isSidingCapped(undefined)).toBe(false);
    expect(isSidingCapped({ cappedAt: null })).toBe(false);
    expect(isSidingCapped({ cappedAt: T0 })).toBe(true);
  });
});

describe("recordTrainSidingDrop (#1192)", () => {
  it("sends a 409-safe rebase turn, records the siding, and tags the workspace", async () => {
    const { db } = createTestDb();
    const { workspaceId, issueId } = await seedMember(db);
    const sendTurn = vi.fn().mockResolvedValue({ type: "sent" });
    const getBranchHeadSha = vi.fn().mockResolvedValue("member-sha-1");

    await recordTrainSidingDrop(
      { workspaceId, issueId, issueNumber: 1, branch: "feature/ak-1" },
      { reason: "Merge conflict in: src/foo.ts", baseBranch: "master", trainTipSha: "traintip1", repoPath: "/repo" },
      { database: db, sendTurn, getBranchHeadSha },
    );

    expect(sendTurn).toHaveBeenCalledTimes(1);
    const [sentWorkspaceId, prompt] = sendTurn.mock.calls[0];
    expect(sentWorkspaceId).toBe(workspaceId);
    expect(prompt).toContain("update-base");
    expect(prompt).toContain("src/foo.ts");

    const row = await getTrainSidingState(workspaceId, db);
    expect(row?.sidings).toBe(1);
    expect(row?.sidedBranchSha).toBe("member-sha-1");
    expect(row?.conflictTrainTipSha).toBe("traintip1");
    expect(row?.cappedAt).toBeNull();

    const tagRows = await db.select().from(issueTags).where(eq(issueTags.issueId, issueId));
    expect(tagRows).toHaveLength(1);
  });

  it("never throws when the agent is busy (409) — the siding is still recorded", async () => {
    const { db } = createTestDb();
    const { workspaceId, issueId } = await seedMember(db);
    const sendTurn = vi.fn().mockRejectedValue(new Error("Agent is busy"));

    await expect(
      recordTrainSidingDrop(
        { workspaceId, issueId, branch: "feature/ak-1" },
        { reason: "Merge conflict in: src/foo.ts", baseBranch: "master", trainTipSha: "traintip1", repoPath: "/repo" },
        { database: db, sendTurn, getBranchHeadSha: async () => "sha-a" },
      ),
    ).resolves.toBeUndefined();

    const row = await getTrainSidingState(workspaceId, db);
    expect(row?.sidings).toBe(1);
  });

  it("stops nudging and comments exactly once after the cap is reached", async () => {
    const { db } = createTestDb();
    const { workspaceId, issueId } = await seedMember(db);
    const sendTurn = vi.fn().mockResolvedValue({ type: "sent" });
    // Same sha every time — as if the agent never rebased between attempts.
    const getBranchHeadSha = vi.fn().mockResolvedValue("stuck-sha");

    for (let i = 0; i < TRAIN_SIDING_MAX_ATTEMPTS + 2; i++) {
      await recordTrainSidingDrop(
        { workspaceId, issueId, branch: "feature/ak-1" },
        { reason: `Merge conflict in: src/foo${i}.ts`, baseBranch: "master", trainTipSha: `tip${i}`, repoPath: "/repo" },
        { database: db, sendTurn, getBranchHeadSha },
      );
    }

    // One turn per attempt up to and including the one that crosses the cap, none after.
    expect(sendTurn).toHaveBeenCalledTimes(TRAIN_SIDING_MAX_ATTEMPTS - 1);

    const row = await getTrainSidingState(workspaceId, db);
    expect(row?.cappedAt).not.toBeNull();

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain(String(TRAIN_SIDING_MAX_ATTEMPTS));
  });
});

describe("partitionSidedMembers (#1192)", () => {
  it("admits a member with no siding history", async () => {
    const { db } = createTestDb();
    const { workspaceId, issueId } = await seedMember(db);
    const sendTurn = vi.fn();
    const member = { workspaceId, issueId, branch: "feature/ak-1" };

    const { admitted, held } = await partitionSidedMembers([member], "/repo", { database: db, sendTurn });
    expect(admitted).toEqual([member]);
    expect(held).toEqual([]);
  });

  it("holds a member whose branch tip has not moved since its last siding", async () => {
    const { db } = createTestDb();
    const { workspaceId, issueId } = await seedMember(db);
    const sendTurn = vi.fn().mockResolvedValue({ type: "sent" });
    const member = { workspaceId, issueId, branch: "feature/ak-1" };

    await recordTrainSidingDrop(
      member,
      { reason: "Merge conflict in: src/foo.ts", baseBranch: "master", trainTipSha: "tip1", repoPath: "/repo" },
      { database: db, sendTurn, getBranchHeadSha: async () => "unchanged-sha" },
    );

    const { admitted, held } = await partitionSidedMembers([member], "/repo", {
      database: db,
      sendTurn,
      getBranchHeadSha: async () => "unchanged-sha",
    });
    expect(admitted).toEqual([]);
    expect(held).toHaveLength(1);
    expect(held[0].member).toEqual(member);
  });

  it("re-admits once the branch tip moves, clearing the tag but keeping the sidings count", async () => {
    const { db } = createTestDb();
    const { workspaceId, issueId } = await seedMember(db);
    const sendTurn = vi.fn().mockResolvedValue({ type: "sent" });
    const member = { workspaceId, issueId, branch: "feature/ak-1" };

    await recordTrainSidingDrop(
      member,
      { reason: "Merge conflict in: src/foo.ts", baseBranch: "master", trainTipSha: "tip1", repoPath: "/repo" },
      { database: db, sendTurn, getBranchHeadSha: async () => "old-sha" },
    );
    const { admitted, held } = await partitionSidedMembers([member], "/repo", {
      database: db,
      sendTurn,
      getBranchHeadSha: async () => "rebased-sha",
    });
    expect(admitted).toEqual([member]);
    expect(held).toEqual([]);

    // The branch-sha GATE is cleared (so the member is no longer held) but the row itself, and
    // its sidings count, survive — a full reset happens only on landing (clearTrainSiding).
    // Otherwise a branch that keeps rebasing into a NEW conflict every window would reset its
    // own counter every time and never reach the cap (#1192 follow-up fix).
    const row = await getTrainSidingState(workspaceId, db);
    expect(row?.sidings).toBe(1);
    expect(row?.sidedBranchSha).toBeNull();
    const tagRows = await db.select().from(issueTags).where(eq(issueTags.issueId, issueId));
    expect(tagRows).toEqual([]);
  });

  it("accumulates sidings toward the cap across repeated rebase-then-reconflict cycles", async () => {
    const { db } = createTestDb();
    const { workspaceId, issueId } = await seedMember(db);
    const sendTurn = vi.fn().mockResolvedValue({ type: "sent" });
    const member = { workspaceId, issueId, branch: "feature/ak-1" };

    // Each cycle: dropped at a sha, then the agent rebases (tip moves) before the next window —
    // a genuine, repeated conflict, never a stuck/untouched branch.
    for (let i = 0; i < TRAIN_SIDING_MAX_ATTEMPTS; i++) {
      await recordTrainSidingDrop(
        member,
        { reason: `Merge conflict in: src/foo${i}.ts`, baseBranch: "master", trainTipSha: `tip${i}`, repoPath: "/repo" },
        { database: db, sendTurn, getBranchHeadSha: async () => `sha-${i}` },
      );
      await partitionSidedMembers([member], "/repo", {
        database: db,
        sendTurn,
        getBranchHeadSha: async () => `sha-${i}-rebased`,
      });
    }

    const row = await getTrainSidingState(workspaceId, db);
    expect(row?.sidings).toBe(TRAIN_SIDING_MAX_ATTEMPTS);
    expect(row?.cappedAt).not.toBeNull();
  });
});

describe("clearTrainSiding", () => {
  it("removes the siding row and the tag", async () => {
    const { db } = createTestDb();
    const { workspaceId, issueId } = await seedMember(db);
    const sendTurn = vi.fn().mockResolvedValue({ type: "sent" });
    const member = { workspaceId, issueId, branch: "feature/ak-1" };

    await recordTrainSidingDrop(
      member,
      { reason: "Merge conflict in: src/foo.ts", baseBranch: "master", trainTipSha: "tip1", repoPath: "/repo" },
      { database: db, sendTurn, getBranchHeadSha: async () => "sha-a" },
    );
    await clearTrainSiding(member, { database: db, sendTurn });

    expect(await getTrainSidingState(workspaceId, db)).toBeUndefined();
    const tagRows = await db.select().from(issueTags).where(eq(issueTags.issueId, issueId));
    expect(tagRows).toEqual([]);
  });
});

describe("TRAIN_SIDING_TAG", () => {
  it("is the tag name the ticket asks for", () => {
    expect(TRAIN_SIDING_TAG).toBe("train-siding");
  });
});
