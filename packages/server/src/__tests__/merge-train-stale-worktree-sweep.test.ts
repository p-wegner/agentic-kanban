import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projects } from "@agentic-kanban/shared/schema";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { createWorktree } from "@agentic-kanban/shared/lib/git-service";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMergeTrain, updateMergeTrainState } from "../repositories/merge-train.repository.js";
import { sweepStaleTrainWorktrees } from "../startup/merge-train-reconciler.js";

/**
 * #1208 — a train's staging worktree (`.worktrees/<repo>/train/kanban_train_<label>`) is
 * removed by its own per-attempt `finally` on every NORMAL exit; this sweep is the recovery
 * for the crash case that `finally` cannot cover (process killed by pid mid-gate), matching a
 * leftover directory back to its row by the same sanitized leaf `createWorktree` produced it
 * with, and removing it once that row is terminal.
 */
let repo: string;
const git = (args: string[]) => gitExecOrThrow(args, { cwd: repo });

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "kanban-train-sweep-"));
  await git(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
  await git(["add", "."]);
  await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "chore: base"]);
});

afterEach(() => {
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function seedProject(db: TestDb, repoPath: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(projects).values({
    id, name: basename(repoPath), repoPath, repoName: basename(repoPath), defaultBranch: "main",
    createdAt: now, updatedAt: now,
  });
  return id;
}

/** Creates the SAME staging worktree shape `runGate` does: `pathNamespace: "train"`, branch `kanban/train/<label>`. */
async function makeTrainStagingWorktree(label: string): Promise<string> {
  return createWorktree(repo, `kanban/train/${label}`, "main", { pathNamespace: "train" });
}

/**
 * `createWorktree` returns a native (backslash, on Windows) path; the sweep's own `removed`/
 * `unknown` paths come from `git worktree list --porcelain` via `listWorktrees`, which always
 * reports forward slashes. Compare on the SLASH-NORMALIZED form so the assertions test identity
 * of the path, not which of git's or Node's conventions produced the string.
 */
function normSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

describe("sweepStaleTrainWorktrees (#1208)", () => {
  it("removes a train staging worktree whose row is landed", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db, repo);
    const trainId = randomUUID();
    await createMergeTrain({ id: trainId, projectId, label: "train/2026-09-19-01", memberWorkspaceIds: ["ws-1"] }, db);
    await updateMergeTrainState(trainId, { state: "landed", finishedAt: new Date().toISOString() }, db);
    const worktreePath = await makeTrainStagingWorktree("train/2026-09-19-01");
    expect(existsSync(worktreePath)).toBe(true);

    const result = await sweepStaleTrainWorktrees({ database: db });

    expect(result.removed.map((r) => normSlash(r.path))).toEqual([normSlash(worktreePath)]);
    expect(result.unknown).toEqual([]);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("leaves a worktree alone whose row is still assembling/gating", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db, repo);
    const trainId = randomUUID();
    await createMergeTrain({ id: trainId, projectId, label: "train/2026-09-19-02", memberWorkspaceIds: ["ws-1"] }, db);
    await updateMergeTrainState(trainId, { state: "gating" }, db);
    const worktreePath = await makeTrainStagingWorktree("train/2026-09-19-02");

    const result = await sweepStaleTrainWorktrees({ database: db });

    expect(result.removed).toEqual([]);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("reports, but does not remove, a train worktree whose label matches no row at all", async () => {
    const { db } = createTestDb();
    await seedProject(db, repo);
    const worktreePath = await makeTrainStagingWorktree("train/2026-09-19-99");

    const result = await sweepStaleTrainWorktrees({ database: db });

    expect(result.removed).toEqual([]);
    expect(result.unknown.map((r) => normSlash(r.path))).toEqual([normSlash(worktreePath)]);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("dry-run reports what it would remove and changes nothing", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db, repo);
    const trainId = randomUUID();
    await createMergeTrain({ id: trainId, projectId, label: "train/2026-09-19-03", memberWorkspaceIds: ["ws-1"] }, db);
    await updateMergeTrainState(trainId, { state: "abandoned", finishedAt: new Date().toISOString() }, db);
    const worktreePath = await makeTrainStagingWorktree("train/2026-09-19-03");

    const result = await sweepStaleTrainWorktrees({ database: db, dryRun: true });

    expect(result.removed.map((r) => normSlash(r.path))).toEqual([normSlash(worktreePath)]);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("a boot with two stale dirs and one live removes exactly the two stale ones", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db, repo);

    const landedId = randomUUID();
    await createMergeTrain({ id: landedId, projectId, label: "train/2026-09-19-04", memberWorkspaceIds: ["ws-1"] }, db);
    await updateMergeTrainState(landedId, { state: "landed", finishedAt: new Date().toISOString() }, db);
    const landedPath = await makeTrainStagingWorktree("train/2026-09-19-04");

    const abandonedId = randomUUID();
    await createMergeTrain({ id: abandonedId, projectId, label: "train/2026-09-19-05", memberWorkspaceIds: ["ws-2"] }, db);
    await updateMergeTrainState(abandonedId, { state: "abandoned", reconciledReason: "cancelled by operator", finishedAt: new Date().toISOString() }, db);
    const abandonedPath = await makeTrainStagingWorktree("train/2026-09-19-05");

    const liveId = randomUUID();
    await createMergeTrain({ id: liveId, projectId, label: "train/2026-09-19-06", memberWorkspaceIds: ["ws-3"] }, db);
    await updateMergeTrainState(liveId, { state: "gating" }, db);
    const livePath = await makeTrainStagingWorktree("train/2026-09-19-06");

    const result = await sweepStaleTrainWorktrees({ database: db });

    expect(result.removed.map((r) => normSlash(r.path)).sort()).toEqual([normSlash(abandonedPath), normSlash(landedPath)].sort());
    expect(existsSync(landedPath)).toBe(false);
    expect(existsSync(abandonedPath)).toBe(false);
    expect(existsSync(livePath)).toBe(true);
  });
});
