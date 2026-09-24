import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projects } from "@agentic-kanban/shared/schema";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { createWorktree } from "@agentic-kanban/shared/lib/git-service";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMergeTrain, updateMergeTrainState } from "../repositories/merge-train.repository.js";
import { reconcileOrphanedWorktrees, realUnshippedWorkProbe } from "../startup/orphaned-worktree-reconciler.js";
import * as gitService from "../services/git.service.js";
import {
  cleanupTrainWorktreesForLabel,
  decideTrainWorktreeAction,
  findTrainRowForAttemptLabel,
  resetUnknownTrainWorktreeLog,
} from "../services/merge-train-worktrees.js";

/**
 * #1235 — `kanban/train/*` worktrees are reaped by their `merge_trains` row's state, not kept
 * forever on the "unmerged commits" they hold (which are the train's own integration merges).
 *
 * Every case runs against a REAL temp git repo: the defect was that the real probe saw commits
 * on the train branch and kept the worktree, so a fake port that never reports commits would
 * not reproduce the situation the fix exists for.
 */
let repo: string;
const git = (args: string[], cwd = repo) => gitExecOrThrow(args, { cwd });
const COMMIT_ID = ["-c", "user.email=t@t", "-c", "user.name=t"];

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "kanban-train-reap-"));
  await git(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
  await git(["add", "."]);
  await git([...COMMIT_ID, "commit", "-q", "-m", "chore: base"]);
  resetUnknownTrainWorktreeLog();
});

afterEach(() => {
  // `createWorktree` places worktrees beside the repo under `.worktrees/<repo name>/`; remove
  // exactly that subtree, never the shared `.worktrees` root other tests are using.
  for (const p of [repo, join(dirname(repo), ".worktrees", basename(repo))]) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

async function seedProject(db: TestDb): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(projects).values({
    id, name: basename(repo), repoPath: repo, repoName: basename(repo), defaultBranch: "main",
    createdAt: now, updatedAt: now,
  });
  return id;
}

/**
 * The exact shape the reconciler kept: a train staging worktree whose branch carries a commit
 * `main` does not have — the train's integration merge, here stood in by an empty commit.
 */
async function makeTrainWorktreeWithCommit(attemptLabel: string): Promise<string> {
  const wt = await createWorktree(repo, `kanban/train/${attemptLabel}`, "main", { pathNamespace: "train" });
  await git([...COMMIT_ID, "commit", "-q", "--allow-empty", "-m", `Merge train ${attemptLabel}`], wt);
  return wt;
}

async function seedTrain(db: TestDb, projectId: string, label: string, state: "landed" | "red" | "abandoned" | "gating" | "assembling" | "landing"): Promise<void> {
  const id = randomUUID();
  await createMergeTrain({ id, projectId, label, memberWorkspaceIds: ["ws-1"] }, db);
  if (state !== "assembling") {
    await updateMergeTrainState(id, { state, ...(state === "landed" || state === "red" || state === "abandoned" ? { finishedAt: new Date().toISOString() } : {}) }, db);
  }
}

async function branchExists(branch: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function reconcile(db: TestDb, trainRows: Array<{ label: string; state: string }> | undefined) {
  return reconcileOrphanedWorktrees({
    repoPath: repo,
    baseBranch: "main",
    claims: [],
    git: { ...gitService, ...realUnshippedWorkProbe },
    database: db,
    trainRows,
  });
}

describe("findTrainRowForAttemptLabel (#1235)", () => {
  const rows = [
    { label: "train/2026-09-19-03", state: "landed" },
    { label: "train/2026-09-19-030", state: "gating" },
    { label: "qmu0lepav", state: "abandoned" },
    { label: "qmu0lepava", state: "landed" },
  ];

  it("matches the row's own label and a bisect child (label + trailing letters)", () => {
    expect(findTrainRowForAttemptLabel("train/2026-09-19-03", rows)?.label).toBe("train/2026-09-19-03");
    expect(findTrainRowForAttemptLabel("train/2026-09-19-03babb", rows)?.label).toBe("train/2026-09-19-03");
  });

  it("does not let a shorter label claim a different row's attempt", () => {
    // `…-030` is its own row, not a bisect child of `…-03` (a digit is not a bisect letter).
    expect(findTrainRowForAttemptLabel("train/2026-09-19-030", rows)?.label).toBe("train/2026-09-19-030");
    expect(findTrainRowForAttemptLabel("train/2026-09-19-04", rows)).toBeUndefined();
  });

  it("prefers the longest matching row label for the old letter-terminated q-labels", () => {
    expect(findTrainRowForAttemptLabel("qmu0lepava", rows)?.label).toBe("qmu0lepava");
    expect(findTrainRowForAttemptLabel("qmu0lepavab", rows)?.label).toBe("qmu0lepava");
    expect(findTrainRowForAttemptLabel("qmu0lepavb", rows)?.label).toBe("qmu0lepav");
  });

  it("decides remove only for the terminal states landed/red/abandoned", () => {
    expect(decideTrainWorktreeAction({ state: "landed" })).toBe("remove");
    expect(decideTrainWorktreeAction({ state: "red" })).toBe("remove");
    expect(decideTrainWorktreeAction({ state: "abandoned" })).toBe("remove");
    expect(decideTrainWorktreeAction({ state: "assembling" })).toBe("keep_in_flight");
    expect(decideTrainWorktreeAction({ state: "gating" })).toBe("keep_in_flight");
    expect(decideTrainWorktreeAction({ state: "landing" })).toBe("keep_in_flight");
    expect(decideTrainWorktreeAction(undefined)).toBe("keep_unknown");
  });
});

describe("reconcileOrphanedWorktrees reaps train worktrees by row state (#1235)", () => {
  it("removes a landed train's worktree AND its branch, despite the commits it holds", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    await seedTrain(db, projectId, "train/2026-09-24-01", "landed");
    const wt = await makeTrainWorktreeWithCommit("train/2026-09-24-01");

    // The pre-fix verdict, for contrast: without rows the probe keeps it on its merge commit.
    const before = await reconcile(db, undefined);
    expect(before.keptWithUnshippedWork).toEqual([expect.stringContaining("kanban_train_")]);
    expect(existsSync(wt)).toBe(true);

    const report = await reconcile(db, [{ label: "train/2026-09-24-01", state: "landed" }]);

    expect(report.removedTrain).toHaveLength(1);
    expect(report.keptWithUnshippedWork).toEqual([]);
    expect(existsSync(wt)).toBe(false);
    expect(await branchExists("kanban/train/train/2026-09-24-01")).toBe(false);
  });

  it("removes a bisect attempt's worktree by its parent row (landed) and an abandoned one", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    await seedTrain(db, projectId, "train/2026-09-24-02", "landed");
    await seedTrain(db, projectId, "train/2026-09-24-03", "abandoned");
    const bisect = await makeTrainWorktreeWithCommit("train/2026-09-24-02babb");
    const abandoned = await makeTrainWorktreeWithCommit("train/2026-09-24-03");

    const report = await reconcile(db, [
      { label: "train/2026-09-24-02", state: "landed" },
      { label: "train/2026-09-24-03", state: "abandoned" },
    ]);

    expect(report.removedTrain).toHaveLength(2);
    expect(existsSync(bisect)).toBe(false);
    expect(existsSync(abandoned)).toBe(false);
    expect(await branchExists("kanban/train/train/2026-09-24-02babb")).toBe(false);
  });

  it("keeps an in-flight train's worktree without a word about unshipped work", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    await seedTrain(db, projectId, "train/2026-09-24-04", "gating");
    const wt = await makeTrainWorktreeWithCommit("train/2026-09-24-04");

    const report = await reconcile(db, [{ label: "train/2026-09-24-04", state: "gating" }]);

    expect(report.keptTrainInFlight).toHaveLength(1);
    expect(report.removedTrain).toEqual([]);
    expect(report.keptWithUnshippedWork).toEqual([]);
    expect(existsSync(wt)).toBe(true);
    expect(await branchExists("kanban/train/train/2026-09-24-04")).toBe(true);
  });

  it("keeps a train worktree with no row at all, and logs it once per boot, not per sweep", async () => {
    const { db } = createTestDb();
    await seedProject(db);
    const wt = await makeTrainWorktreeWithCommit("qmu0lepava");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = await reconcile(db, []);
      const second = await reconcile(db, []);
      expect(first.keptTrainUnknown).toHaveLength(1);
      expect(second.keptTrainUnknown).toHaveLength(1);
      expect(existsSync(wt)).toBe(true);
      const unknownLogs = warn.mock.calls.filter((c) => String(c[0]).includes("no merge_trains row"));
      expect(unknownLogs).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves a detached scratch-* worktree alone", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    await seedTrain(db, projectId, "train/2026-09-24-05", "landed");
    const scratch = join(dirname(repo), ".worktrees", basename(repo), "scratch-train-repro");
    await git(["worktree", "add", "--detach", "-q", scratch, "main"]);
    expect(existsSync(scratch)).toBe(true);

    const report = await reconcile(db, [{ label: "train/2026-09-24-05", state: "landed" }]);

    expect(report.removedTrain).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(report.keptWithUnshippedWork.map((p) => p.replace(/\\/g, "/"))).toEqual([scratch.replace(/\\/g, "/")]);
    expect(existsSync(scratch)).toBe(true);
  });
});

describe("cleanupTrainWorktreesForLabel — the train's own terminal teardown (#1235)", () => {
  it("removes every attempt worktree of the label (full + bisect halves) with their branches, nothing else", async () => {
    const { db } = createTestDb();
    await seedProject(db);
    const full = await makeTrainWorktreeWithCommit("train/2026-09-24-06");
    const half = await makeTrainWorktreeWithCommit("train/2026-09-24-06a");
    const other = await makeTrainWorktreeWithCommit("train/2026-09-24-07");
    const log = vi.fn();

    const result = await cleanupTrainWorktreesForLabel({ database: db, repoPath: repo, label: "train/2026-09-24-06", log });

    expect(result.removed).toHaveLength(2);
    expect(result.failed).toEqual([]);
    expect(existsSync(full)).toBe(false);
    expect(existsSync(half)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(await branchExists("kanban/train/train/2026-09-24-06")).toBe(false);
    expect(await branchExists("kanban/train/train/2026-09-24-06a")).toBe(false);
    expect(await branchExists("kanban/train/train/2026-09-24-07")).toBe(true);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("never throws — a list failure is logged and returns empty", async () => {
    const { db } = createTestDb();
    const log = vi.fn();
    const result = await cleanupTrainWorktreesForLabel({
      database: db, repoPath: repo, label: "train/2026-09-24-08", log,
      git: { listWorktrees: async () => { throw new Error("boom"); }, removeWorktree: async () => {} },
    });
    expect(result).toEqual({ removed: [], failed: [] });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});
