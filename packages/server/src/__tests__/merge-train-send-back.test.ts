// Base-conflict send-back (live gap 2026-09-27, #1253/#1261): a train member dropped for a
// conflict with the BASE leaves the ready set with a visible reason and gets ONE rebase
// instruction the moment assembly drops it; a member-vs-member (`deferred`) drop is untouched;
// past the cap the member gets a needs-attention merge hold instead of another send-back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { issueComments, issues, projects, projectStatuses, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  TRAIN_SIDING_MAX_ATTEMPTS,
  createTrainDropSendBack,
  partitionSidedMembers,
  recordTrainSidingDrop,
} from "../services/merge-train-siding.service.js";
import {
  TRAIN_SEND_BACK_HOLD_MARKER,
  conflictFilesFromReason,
  formatBaseConflictSendBackPrompt,
} from "../services/merge-train-send-back.js";
import { getMergeHold } from "../repositories/merge-hold.repository.js";
import { runMergeTrain } from "../services/merge-train.service.js";

const T0 = "2026-09-27T00:00:00.000Z";
const REASON = "Merge conflict in: packages/server/src/repositories/merge-queue.repository.ts, src/b.ts";

type Db = ReturnType<typeof createTestDb>["db"];

async function seedProject(db: Db): Promise<{ projectId: string; statusId: string }> {
  const projectId = randomUUID();
  const statusId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo", defaultBranch: "main", createdAt: T0, updatedAt: T0,
  });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: T0 });
  return { projectId, statusId };
}

async function seedMember(db: Db, at: { projectId: string; statusId: string }, workspaceId: string, branch: string, issueNumber: number) {
  const issueId = randomUUID();
  await db.insert(issues).values({
    id: issueId, issueNumber, title: `Issue ${issueNumber}`, priority: "medium", sortOrder: 0,
    statusId: at.statusId, projectId: at.projectId, createdAt: T0, updatedAt: T0,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch, workingDir: `/repo/.worktrees/${workspaceId}`,
    baseBranch: "main", status: "idle", provider: "claude", readyForMerge: true, createdAt: T0, updatedAt: T0,
  });
  return { workspaceId, issueId, issueNumber, branch };
}

async function readyForMerge(db: Db, workspaceId: string): Promise<boolean> {
  const [row] = await db.select({ ready: workspaces.readyForMerge }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return Boolean(row?.ready);
}

describe("the send-back prompt and reason parsing", () => {
  it("parses the files git named, and none from a reason that names none", () => {
    expect(conflictFilesFromReason(REASON)).toEqual(["packages/server/src/repositories/merge-queue.repository.ts", "src/b.ts"]);
    expect(conflictFilesFromReason("fatal: bad revision")).toEqual([]);
  });

  it("tells the builder to rebase onto the LOCAL base, keep both sides, run the covering tests and commit", () => {
    const prompt = formatBaseConflictSendBackPrompt({ branch: "feature/ak-1253-x", baseBranch: "master", trainRef: "kanban/train/train/2026-09-27-06", reason: REASON });
    expect(prompt).toContain("kanban/train/train/2026-09-27-06");
    expect(prompt).toContain("git rebase master");
    expect(prompt).toContain("- packages/server/src/repositories/merge-queue.repository.ts");
    expect(prompt).toContain("BOTH sides");
    expect(prompt).toMatch(/tests that cover/);
    expect(prompt).toContain("Commit");
  });
});

describe("recordTrainSidingDrop with a trainRef: the base-conflict send-back", () => {
  it("withholds readyForMerge with a visible reason, relaunches the builder once, and logs one line", async () => {
    const { db } = createTestDb();
    const at = await seedProject(db);
    const m = await seedMember(db, at, randomUUID(), "feature/ak-1253-x", 1253);
    const relaunch = vi.fn().mockResolvedValue({ sessionId: "s1" });
    const sendTurn = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await recordTrainSidingDrop(
        m,
        { reason: REASON, baseBranch: "main", trainTipSha: "base-sha", repoPath: "/repo", trainRef: "kanban/train/train/2026-09-27-06" },
        { database: db, sendTurn, relaunch, hasLiveSession: async () => false, getBranchHeadSha: async () => "tip-1", now: T0 },
      );
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("sent back"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("feature/ak-1253-x (#1253)");
      expect(lines[0]).toContain("kanban/train/train/2026-09-27-06");
      expect(lines[0]).toContain("merge-queue.repository.ts");
    } finally {
      log.mockRestore();
    }

    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(relaunch.mock.calls[0][0]).toBe(m.workspaceId);
    expect(relaunch.mock.calls[0][1]).toContain("git rebase main");
    expect(sendTurn).not.toHaveBeenCalled();
    expect(await readyForMerge(db, m.workspaceId)).toBe(false);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, m.issueId));
    expect(comments).toHaveLength(1);
    // `merge-attempt` is also what stops the stranded-review reconciler (#932) re-arming the flag.
    expect(comments[0].kind).toBe("merge-attempt");
    expect(comments[0].body).toContain("no longer ready for merge");
    expect(await getMergeHold(m.workspaceId, db)).toBeUndefined();
  });

  it("nudges a LIVE builder with a /turn carrying the same instruction", async () => {
    const { db } = createTestDb();
    const at = await seedProject(db);
    const m = await seedMember(db, at, randomUUID(), "feature/ak-1", 1);
    const sendTurn = vi.fn().mockResolvedValue({ type: "sent" });
    const relaunch = vi.fn();

    await recordTrainSidingDrop(
      m,
      { reason: REASON, baseBranch: "main", trainTipSha: "base-sha", repoPath: "/repo", trainRef: "kanban/train/t1" },
      { database: db, sendTurn, relaunch, hasLiveSession: async () => true, getBranchHeadSha: async () => "tip-1", now: T0 },
    );

    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(sendTurn.mock.calls[0][1]).toContain("git rebase main");
    expect(relaunch).not.toHaveBeenCalled();
    expect(await readyForMerge(db, m.workspaceId)).toBe(false);
  });

  it("puts readyForMerge back when the send-back could not be delivered", async () => {
    const { db } = createTestDb();
    const at = await seedProject(db);
    const m = await seedMember(db, at, randomUUID(), "feature/ak-1", 1);
    const relaunch = vi.fn().mockRejectedValue(new Error("project quiesced"));

    await recordTrainSidingDrop(
      m,
      { reason: REASON, baseBranch: "main", trainTipSha: "base-sha", repoPath: "/repo", trainRef: "kanban/train/t1" },
      { database: db, sendTurn: vi.fn(), relaunch, hasLiveSession: async () => false, getBranchHeadSha: async () => "tip-1", now: T0 },
    );

    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(await readyForMerge(db, m.workspaceId)).toBe(true);
  });

  it("after the cap, places a needs-attention merge hold instead of another send-back", async () => {
    const { db } = createTestDb();
    const at = await seedProject(db);
    const m = await seedMember(db, at, randomUUID(), "feature/ak-1", 1);
    const relaunch = vi.fn().mockResolvedValue({ sessionId: "s" });

    // Each round: dropped at a tip, the builder rebases (tip moves, re-admitted), dropped again.
    for (let i = 0; i < TRAIN_SIDING_MAX_ATTEMPTS; i++) {
      await recordTrainSidingDrop(
        m,
        { reason: REASON, baseBranch: "main", trainTipSha: `base-${i}`, repoPath: "/repo", trainRef: `kanban/train/t${i}` },
        { database: db, sendTurn: vi.fn(), relaunch, hasLiveSession: async () => false, getBranchHeadSha: async () => `tip-${i}`, now: T0 },
      );
      await partitionSidedMembers([m], "/repo", { database: db, sendTurn: vi.fn(), getBranchHeadSha: async () => `tip-${i}-rebased` });
    }

    expect(relaunch).toHaveBeenCalledTimes(TRAIN_SIDING_MAX_ATTEMPTS - 1);
    const hold = await getMergeHold(m.workspaceId, db);
    expect(hold?.reason?.startsWith(TRAIN_SEND_BACK_HOLD_MARKER)).toBe(true);
    expect(hold?.reason).toContain("needs attention");
    expect(hold?.reason).toContain("merge-queue.repository.ts");
    expect(await readyForMerge(db, m.workspaceId)).toBe(false);
  });

  it("without a trainRef (the train review's siding, #1194) neither withholds the flag nor holds", async () => {
    const { db } = createTestDb();
    const at = await seedProject(db);
    const m = await seedMember(db, at, randomUUID(), "feature/ak-1", 1);
    const sendTurn = vi.fn().mockResolvedValue({ type: "sent" });

    await recordTrainSidingDrop(
      m,
      { reason: "train review: 1 blocking finding", baseBranch: "main", trainTipSha: "tip", repoPath: "/repo" },
      { database: db, sendTurn, hasLiveSession: async () => true, getBranchHeadSha: async () => "tip-1", now: T0 },
    );

    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(sendTurn.mock.calls[0][1]).toContain("update-base");
    expect(await readyForMerge(db, m.workspaceId)).toBe(true);
  });
});

describe("createTrainDropSendBack", () => {
  it("sends back a base-conflict drop once per train and never a deferred (member-vs-member) drop", async () => {
    const { db } = createTestDb();
    const at = await seedProject(db);
    const stale = await seedMember(db, at, "w-stale", "f-stale", 1);
    const deferred = await seedMember(db, at, "w-deferred", "f-deferred", 2);
    const relaunch = vi.fn().mockResolvedValue({ sessionId: "s" });
    const port = createTrainDropSendBack({
      members: [stale, deferred], baseBranch: "main", repoPath: "/repo",
      deps: { database: db, sendTurn: vi.fn(), relaunch, hasLiveSession: async () => false, getBranchHeadSha: async () => "tip", now: T0 },
    });

    const drops = [
      { member: { workspaceId: "w-stale" }, reason: REASON },
      { member: { workspaceId: "w-deferred" }, reason: "conflicts with f-x (#3) — deferred to the next train", deferred: true },
    ];
    await port.onDropped(drops, { trainRef: "kanban/train/t1", tipSha: "base" });
    // A bisect half or the end-of-train pass re-reports the same drop.
    await port.onDropped(drops, { trainRef: "kanban/train/t1a", tipSha: "base" });

    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(relaunch.mock.calls[0][0]).toBe("w-stale");
    expect(await readyForMerge(db, "w-stale")).toBe(false);
    expect(await readyForMerge(db, "w-deferred")).toBe(true);
    const deferredComments = await db.select().from(issueComments).where(eq(issueComments.issueId, deferred.issueId));
    expect(deferredComments).toEqual([]);
  });
});

describe("runMergeTrain sends a base-conflict member back BEFORE its gate runs", () => {
  let repo: string;
  async function git(args: string[]) {
    return gitExecOrThrow(args, { cwd: repo });
  }
  async function commitFile(branch: string, name: string, content: string) {
    await git(["checkout", "-q", branch]);
    writeFileSync(join(repo, name), content, "utf8");
    await git(["add", name]);
    await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `feat: ${name} on ${branch}`]);
  }

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "kanban-train-sendback-"));
    await git(["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
    await git(["add", "."]);
    await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "chore: base"]);
    // f-stale conflicts with the BASE; f-a and f-b conflict with EACH OTHER (one is deferred);
    // f-clean conflicts with nothing.
    for (const b of ["f-stale", "f-a", "f-b", "f-clean"]) await git(["branch", b]);
    await commitFile("f-stale", "shared.txt", "from branch\n");
    await commitFile("f-a", "pair.txt", "from a\n");
    await commitFile("f-b", "pair.txt", "from b\n");
    await commitFile("f-clean", "clean.txt", "clean\n");
    await commitFile("main", "shared.txt", "from main\n");
  });

  afterEach(() => {
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("relaunches only the base-conflict member, before the gate, and even when the gate then throws", async () => {
    const { db } = createTestDb();
    const at = await seedProject(db);
    const members = [
      await seedMember(db, at, "w-stale", "f-stale", 1),
      await seedMember(db, at, "w-a", "f-a", 2),
      await seedMember(db, at, "w-b", "f-b", 3),
      await seedMember(db, at, "w-clean", "f-clean", 4),
    ];
    const events: string[] = [];
    const relaunch = vi.fn(async (workspaceId: string) => { events.push(`relaunch:${workspaceId}`); });
    const port = createTrainDropSendBack({
      members, baseBranch: "main", repoPath: repo,
      deps: { database: db, sendTurn: vi.fn(), relaunch, hasLiveSession: async () => false, now: T0 },
    });
    // The train job dies at its gate: before this change nothing was ever sent back then.
    const runGate = vi.fn(async () => { events.push("gate"); throw new Error("gate worker died"); });

    await expect(runMergeTrain({
      repoPath: repo, baseBranch: "main", members, label: "t-sendback",
      runGate, closeMember: async () => {}, onDropped: port.onDropped,
    })).rejects.toThrow("gate worker died");

    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(relaunch.mock.calls[0][0]).toBe("w-stale");
    expect(events).toEqual(["relaunch:w-stale", "gate"]);
    expect(await readyForMerge(db, "w-stale")).toBe(false);
    // Deferred (member-vs-member) and clean members are untouched.
    for (const id of ["w-a", "w-b", "w-clean"]) expect(await readyForMerge(db, id)).toBe(true);
  });
}, 120000);
