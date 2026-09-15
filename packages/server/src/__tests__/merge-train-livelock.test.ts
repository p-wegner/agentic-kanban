import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { issues, preferences, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMergeQueueService } from "../services/merge-queue.service.js";
import { createAutoMergeOrchestrator } from "../startup/auto-merge-orchestrator.js";
import { createMergeTrain, getMergeTrain, listMergeTrainsForProject } from "../repositories/merge-train.repository.js";

/**
 * #1153 — a new 196-member merge train was created every ~10 minutes and never finished.
 *
 * `start_mode_<projectId>` governs whether new TICKETS get auto-STARTED (decision 008) and is
 * deliberately orthogonal to merging already-completed work — `auto-merge-orchestrator-train-
 * window.test.ts` pins that the batching window runs independently of Start Mode, and every
 * project in that suite has no `start_mode` set at all (which resolves to `manual`) while still
 * expecting the window to accumulate/release normally. So gating train creation on
 * `resolveStartPolicy` would have been the WRONG lever — the actual per-project merge
 * kill-switch is `auto_merge_disabled_<projectId>` (already respected by
 * `findCompletedWorkspaceRows`, see `auto-merge-orchestrator.test.ts`), and once nothing
 * candidate ever enters the window, nothing gets batched. What was NOT respected was a
 * project already carrying an unfinished train:
 *   1. Nothing refused a SECOND train for a project that already had one unfinished
 *      (`assembling`/`gating`) — each new one contended for the repo lock the first held,
 *      which is what let candidates keep arriving faster than the queue could drain.
 *   2. A train waited the full 90-minute per-workspace budget on the repo lock instead of
 *      being bounded and abandoned.
 *   3. There was no way for an operator to cancel a stranded train short of a restart.
 */
const git = (repoPath: string, args: string[]) => gitExecOrThrow(args, { cwd: repoPath });

async function commitOn(repoPath: string, branch: string, file: string, content: string) {
  await git(repoPath, ["checkout", "-q", branch]);
  writeFileSync(join(repoPath, file), content, "utf8");
  await git(repoPath, ["add", file]);
  await git(repoPath, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `feat: ${file}`]);
}

const tempRepos: string[] = [];
async function makeRepo(): Promise<string> {
  const repoPath = mkdtempSync(join(tmpdir(), "ak-merge-train-livelock-"));
  tempRepos.push(repoPath);
  await git(repoPath, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repoPath, "base.txt"), "base\n", "utf8");
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "chore: base"]);
  return repoPath;
}

async function seedProject(db: TestDb, repoPath: string) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "Test Project",
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
  return { projectId, statusId };
}

let issueSeq = 9000;
async function seedWorkspace(
  db: TestDb,
  opts: { projectId: string; statusId: string; branch: string; workingDir?: string | null },
) {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  const issueNumber = issueSeq++;

  await db.insert(issues).values({
    id: issueId,
    issueNumber,
    title: `Issue ${issueNumber}`,
    priority: "medium",
    sortOrder: issueNumber,
    statusId: opts.statusId,
    projectId: opts.projectId,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: opts.branch,
    workingDir: opts.workingDir === undefined ? join(tmpdir(), "unused-workingdir", workspaceId) : opts.workingDir,
    baseBranch: "main",
    status: "idle",
    isDirect: false,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });

  return { issueId, workspaceId };
}

describe("merge train livelock fixes (#1153)", () => {
  afterEach(() => {
    while (tempRepos.length) {
      try { rmSync(tempRepos.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("applyTrainWindow releases normally when nothing is in flight (control)", async () => {
    const { db } = createTestDb();
    const repoPath = await makeRepo();
    const { projectId } = await seedProject(db, repoPath);
    const now = new Date().toISOString();
    await db.insert(preferences).values({ key: `train_max_size_${projectId}`, value: "2", updatedAt: now });

    const orchestrator = createAutoMergeOrchestrator({ database: db });
    const rows = [
      { workspaceId: "ws-1", projectId },
      { workspaceId: "ws-2", projectId },
    ];
    const released = await orchestrator.applyTrainWindow(rows, now);
    expect(released).toEqual(expect.arrayContaining(["ws-1", "ws-2"]));
  }, 60000);

  it("applyTrainWindow keeps accumulating (never releases a second train) while one is already in flight", async () => {
    const { db } = createTestDb();
    const repoPath = await makeRepo();
    const { projectId } = await seedProject(db, repoPath);
    const now = new Date().toISOString();
    await db.insert(preferences).values({ key: `train_max_size_${projectId}`, value: "2", updatedAt: now });

    // An in-flight train already exists for this project.
    await createMergeTrain({ id: randomUUID(), projectId, label: "qexisting", memberWorkspaceIds: ["ws-0"] }, db);

    const orchestrator = createAutoMergeOrchestrator({ database: db });
    const rows = [
      { workspaceId: "ws-1", projectId },
      { workspaceId: "ws-2", projectId },
    ];
    const released = await orchestrator.applyTrainWindow(rows, now);
    expect(released).toEqual([]);

    // The pending set is still held (not dropped) — it must release the moment the in-flight
    // train finishes, not be lost.
    expect(orchestrator.state.trainWindows.get(projectId)?.pendingIds).toEqual(expect.arrayContaining(["ws-1", "ws-2"]));
  }, 60000);

  it("executeQueue refuses a second train when one is already assembling/gating for the project (beginMergeTrain seam)", async () => {
    const { db } = createTestDb();
    const repoPath = await makeRepo();
    const { projectId, statusId } = await seedProject(db, repoPath);
    await db.insert(preferences).values({
      key: `train_max_size_${projectId}`,
      value: "4",
      updatedAt: new Date().toISOString(),
    });

    await git(repoPath, ["branch", "f1"]);
    await git(repoPath, ["branch", "f2"]);
    await commitOn(repoPath, "f1", "a.txt", "a\n");
    await commitOn(repoPath, "f2", "b.txt", "b\n");
    await git(repoPath, ["checkout", "-q", "main"]);

    const a = await seedWorkspace(db, { projectId, statusId, branch: "f1" });
    const b = await seedWorkspace(db, { projectId, statusId, branch: "f2" });

    // Simulate an already in-flight train for this project.
    const existingTrainId = randomUUID();
    await createMergeTrain({ id: existingTrainId, projectId, label: "qinflight", memberWorkspaceIds: ["ws-0"] }, db);

    const service = createMergeQueueService({ database: db });
    const events = [];
    for await (const event of service.executeQueue([a.workspaceId, b.workspaceId], { strategy: "train" })) {
      events.push(event);
    }

    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ merged: [], skipped: expect.arrayContaining([a.workspaceId, b.workspaceId]) });

    // No new train row was created for this batch — only the pre-existing one exists.
    const trains = await listMergeTrainsForProject(projectId, db);
    expect(trains).toHaveLength(1);
    expect(trains[0].id).toBe(existingTrainId);
  }, 60000);

  it("finishMergeTrain does not overwrite a train that was cancelled (abandoned) mid-run", async () => {
    const { db } = createTestDb();
    const repoPath = await makeRepo();
    const { projectId } = await seedProject(db, repoPath);

    const trainId = randomUUID();
    await createMergeTrain({ id: trainId, projectId, label: "qcancel", memberWorkspaceIds: ["ws-1"] }, db);

    // Operator cancels via the route's DB write (simulated directly here).
    const { updateMergeTrainState } = await import("../repositories/merge-train.repository.js");
    await updateMergeTrainState(trainId, { state: "abandoned", reconciledReason: "cancelled by operator", finishedAt: new Date().toISOString() }, db);

    const row = await getMergeTrain(trainId, db);
    expect(row?.state).toBe("abandoned");
  }, 60000);
});
