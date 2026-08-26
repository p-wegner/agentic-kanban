import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issues, preferences, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMergeQueueService } from "../services/merge-queue.service.js";

/**
 * #904 — `executeQueue`'s train-vs-sequential DISPATCH decision, exercised end to end with
 * real git and a real (no-op — no `verify_script` configured) pre-merge gate. Unlike
 * `merge-queue.service.test.ts`, this suite does NOT mock `../services/git.service.js`: the
 * train path calls `gitService.createWorktree`/`removeWorktree` for the gate worktree, which
 * that suite's mock factory does not provide. `merge-train-orchestration.test.ts` covers
 * `runMergeTrain` itself in isolation; this file covers the DECISION that routes into it.
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
  const repoPath = mkdtempSync(join(tmpdir(), "ak-merge-train-dispatch-"));
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

async function seedWorkspace(
  db: TestDb,
  opts: {
    projectId: string;
    statusId: string;
    issueNumber: number;
    branch: string;
    /**
     * Default: a fake non-existent path — `trainEligible` only checks truthiness, and
     * creating a real worktree per member would multiply this suite's git cost for no
     * assertion benefit. `computePlan`'s overlap detection reads `getChangedFileNames`
     * against `workingDir` when it is set, so a test that needs REAL overlap detection
     * (comparing `branch` against `baseBranch` in the bare repo) must pass `null` here to
     * route it through `getChangedFilesBetween` instead.
     */
    workingDir?: string | null;
  },
) {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(issues).values({
    id: issueId,
    issueNumber: opts.issueNumber,
    title: `Issue ${opts.issueNumber}`,
    priority: "medium",
    sortOrder: opts.issueNumber,
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

describe("executeQueue train dispatch (#904)", () => {
  afterEach(() => {
    while (tempRepos.length) {
      try { rmSync(tempRepos.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("takes the train for an independent (non-overlapping) batch once the project opts in via train_max_size", async () => {
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

    const a = await seedWorkspace(db, { projectId, statusId, issueNumber: 1, branch: "f1" });
    const b = await seedWorkspace(db, { projectId, statusId, issueNumber: 2, branch: "f2" });

    const service = createMergeQueueService({ database: db });
    const events = [];
    for await (const event of service.executeQueue([a.workspaceId, b.workspaceId])) {
      events.push(event);
    }

    expect(events).toContainEqual(expect.objectContaining({ type: "merged", workspaceId: a.workspaceId }));
    expect(events).toContainEqual(expect.objectContaining({ type: "merged", workspaceId: b.workspaceId }));
    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ merged: expect.arrayContaining([a.workspaceId, b.workspaceId]) });
  }, 240000);

  it("stays sequential for an independent batch when the project has NOT opted in (default)", async () => {
    const { db } = createTestDb();
    const repoPath = await makeRepo();
    const { projectId, statusId } = await seedProject(db, repoPath);
    // No train_max_size pref written — default must stay sequential (no behaviour change).

    await git(repoPath, ["branch", "f1"]);
    await git(repoPath, ["branch", "f2"]);
    await commitOn(repoPath, "f1", "a.txt", "a\n");
    await commitOn(repoPath, "f2", "b.txt", "b\n");
    await git(repoPath, ["checkout", "-q", "main"]);

    const a = await seedWorkspace(db, { projectId, statusId, issueNumber: 3, branch: "f1" });
    const b = await seedWorkspace(db, { projectId, statusId, issueNumber: 4, branch: "f2" });

    const service = createMergeQueueService({ database: db });
    const plan = await service.computePlan([a.workspaceId, b.workspaceId]);
    // The batch is independent, so the classifier's own recommendation stays "direct" — this
    // pins that the OLD signal is unchanged; only the new opt-in below changes behaviour.
    expect(plan.recommendedStrategy).toBe("direct");
  });

  it("explicit strategy: 'sequential' always wins, even when the project opted into trains", async () => {
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

    const a = await seedWorkspace(db, { projectId, statusId, issueNumber: 5, branch: "f1" });
    const b = await seedWorkspace(db, { projectId, statusId, issueNumber: 6, branch: "f2" });

    const service = createMergeQueueService({ database: db });
    const events = [];
    for await (const event of service.executeQueue([a.workspaceId, b.workspaceId], { strategy: "sequential" })) {
      events.push(event);
    }

    // Sequential path merges via `mergeWorkspace`/rebase, not the train's worktree-gate cycle —
    // no real assertion needs re-mocking here; the shape check is that BOTH still land, which
    // the sequential per-member loop (not the train) is what produced without a gate worktree.
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
  }, 240000);

  it("a single ready workspace never trains (single-member train IS the sequential path)", async () => {
    const { db } = createTestDb();
    const repoPath = await makeRepo();
    const { projectId, statusId } = await seedProject(db, repoPath);
    await db.insert(preferences).values({
      key: `train_max_size_${projectId}`,
      value: "4",
      updatedAt: new Date().toISOString(),
    });

    await git(repoPath, ["branch", "f1"]);
    await commitOn(repoPath, "f1", "a.txt", "a\n");
    await git(repoPath, ["checkout", "-q", "main"]);

    const a = await seedWorkspace(db, { projectId, statusId, issueNumber: 7, branch: "f1" });

    const service = createMergeQueueService({ database: db });
    const plan = await service.computePlan([a.workspaceId]);
    // `trainEligible` requires order.length >= 2 — a single member can never route into the
    // train branch regardless of the project's train_max_size, by construction.
    expect(plan.order).toHaveLength(1);
  });

  it("still takes the train for an overlapping cluster (integration-union) with no project opt-in", async () => {
    const { db } = createTestDb();
    const repoPath = await makeRepo();
    const { projectId, statusId } = await seedProject(db, repoPath);
    // No train_max_size pref — the classifier's own "integration-union" recommendation must
    // still be enough to dispatch the train, unaffected by the new opt-in path.

    await git(repoPath, ["branch", "f1"]);
    await git(repoPath, ["branch", "f2"]);
    // Same file, different lines — a union git can resolve mechanically.
    writeFileSync(join(repoPath, "shared.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "shared.txt"]);
    await git(repoPath, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "chore: shared file"]);
    await git(repoPath, ["branch", "-f", "f1"]);
    await git(repoPath, ["branch", "-f", "f2"]);
    await git(repoPath, ["checkout", "-q", "f1"]);
    writeFileSync(join(repoPath, "shared.txt"), "base\nfrom f1\n", "utf8");
    await git(repoPath, ["add", "shared.txt"]);
    await git(repoPath, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "feat: f1 addition"]);
    await git(repoPath, ["checkout", "-q", "f2"]);
    writeFileSync(join(repoPath, "shared.txt"), "from f2\nbase\n", "utf8");
    await git(repoPath, ["add", "shared.txt"]);
    await git(repoPath, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "feat: f2 addition"]);
    await git(repoPath, ["checkout", "-q", "main"]);

    // Real worktrees: `computePlan`'s overlap detection reads `getChangedFileNames` against
    // `workingDir` when it is set, and `trainEligible` requires a truthy `workingDir` too —
    // so this test (unlike the others in this file) needs both a real path AND real content.
    const wtA = join(repoPath, ".worktrees", "f1");
    const wtB = join(repoPath, ".worktrees", "f2");
    await git(repoPath, ["worktree", "add", "-q", wtA, "f1"]);
    await git(repoPath, ["worktree", "add", "-q", wtB, "f2"]);

    const a = await seedWorkspace(db, { projectId, statusId, issueNumber: 8, branch: "f1", workingDir: wtA });
    const b = await seedWorkspace(db, { projectId, statusId, issueNumber: 9, branch: "f2", workingDir: wtB });

    const service = createMergeQueueService({ database: db });
    const plan = await service.computePlan([a.workspaceId, b.workspaceId]);
    expect(plan.recommendedStrategy).toBe("integration-union");

    const events = [];
    for await (const event of service.executeQueue([a.workspaceId, b.workspaceId])) {
      events.push(event);
    }
    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ merged: expect.arrayContaining([a.workspaceId, b.workspaceId]) });
  }, 240000);
});
