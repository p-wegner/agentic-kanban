import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { issueTags, issues, preferences, projectStatuses, projects, tags, workspaces } from "@agentic-kanban/shared/schema";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { getIssueComments } from "../repositories/issue-comments.repository.js";
import { getTrainSidingState } from "../repositories/merge-train-siding.repository.js";
import { riskPosturePrefKey } from "../services/risk-posture.service.js";
import { runTrainReview, type TrainReviewMember } from "../services/merge-train-review.service.js";
import { TRAIN_SIDING_TAG, partitionSidedMembers } from "../services/merge-train-siding.service.js";
import { createMergeTrainRunner } from "../services/merge-queue-train.js";
import { createMergeQueueService } from "../services/merge-queue.service.js";

/**
 * #1194 x #1192 — the cross-branch claim neither branch could test alone: a BLOCKING train-review
 * finding pulls its member into a real siding (the `workspace_train_siding` row, the
 * `train-siding` tag, the 409-safe nudge), the member is withheld from the next window while its
 * tip is unchanged, and it re-admits once the tip moves — exactly as a conflict drop would.
 *
 * Two layers. The service layer injects the shas so the row's contents can be pinned exactly;
 * the runner layer drives `runTrainStrategy` against real git and the real siding service with
 * only the reviewer's reply canned, across three windows (side → held → re-admitted and landed).
 */
const SHA40 = /^[0-9a-f]{40}$/;

async function seedTrain(db: TestDb, opts: { repoPath: string; posture: string; branches: string[] }) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "P", repoPath: opts.repoPath, repoName: "r", defaultBranch: "main", createdAt: now, updatedAt: now });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Review", sortOrder: 0, isDefault: true, createdAt: now });
  await db.insert(preferences).values({ key: riskPosturePrefKey(projectId), value: opts.posture, updatedAt: now });
  const members: TrainReviewMember[] = [];
  for (const [i, branch] of opts.branches.entries()) {
    const n = i + 1;
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(issues).values({ id: issueId, issueNumber: n, title: `Issue ${n}`, description: `AC for ${n}`, priority: "medium", sortOrder: n, statusId, projectId, createdAt: now, updatedAt: now });
    await db.insert(workspaces).values({ id: workspaceId, issueId, branch, workingDir: join(tmpdir(), "unused-workingdir", workspaceId), baseBranch: "main", status: "idle", isDirect: false, provider: "claude", createdAt: now, updatedAt: now });
    members.push({ workspaceId, issueId, issueNumber: n, branch, changedFiles: [`src/${n}.ts`] });
  }
  return { projectId, members };
}

/** The tag NAMES on an issue — `issue_tags` only carries the id, the name is on `tags`. */
const tagsOn = async (db: TestDb, issueId: string) =>
  (await db.select({ tag: tags.name }).from(issueTags).innerJoin(tags, eq(issueTags.tagId, tags.id)).where(eq(issueTags.issueId, issueId)))
    .map((r) => r.tag);

describe("train review → siding (#1194 + #1192, service layer)", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => { for (const d of disposers.splice(0)) d(); });

  const critical = (n: number) => async () =>
    `\`\`\`json\n{"summary":"s","findings":[{"member":"#${n}","severity":"CRITICAL","file":"src/${n}.ts","message":"unchecked null"}]}\n\`\`\``;

  it("a blocking finding writes the sided member's siding row, tags it, nudges it — and leaves the clean member alone", async () => {
    const { db, dispose } = createTestDb();
    disposers.push(dispose);
    const { projectId, members } = await seedTrain(db, { repoPath: "C:/nope", posture: "fast", branches: ["f1", "f2"] });
    const [w1, w2] = members;
    const sendTurn = vi.fn().mockResolvedValue({ type: "sent" });
    const shas: Record<string, string> = { f2: "w2-tip-1", "kanban/train/q1": "train-tip-1" };
    const getBranchHeadSha = vi.fn(async (_repo: string, ref: string) => shas[ref] ?? null);

    const res = await runTrainReview(
      { projectId, trainLabel: "q1", trainRef: "kanban/train/q1", baseBranch: "main", gateWorktree: "C:/nope/wt", repoPath: "C:/nope", members, blocking: true, thorough: false },
      { database: db, invoke: critical(2), buildContext: async () => null, sendTurn, getBranchHeadSha },
    );
    expect(res.sided.map((s) => s.workspaceId)).toEqual([w2.workspaceId]);

    // The #1192 side effects, through the real siding service — not a stub of it.
    const row = await getTrainSidingState(w2.workspaceId, db);
    expect(row).toMatchObject({ sidings: 1, sidedBranchSha: "w2-tip-1", conflictTrainTipSha: "train-tip-1", cappedAt: null });
    expect(await tagsOn(db, w2.issueId)).toEqual([TRAIN_SIDING_TAG]);
    expect(sendTurn).toHaveBeenCalledTimes(1);
    const [nudged, prompt] = sendTurn.mock.calls[0];
    expect(nudged).toBe(w2.workspaceId);
    expect(prompt).toContain("unchecked null");
    // The #1194 comment still lands, first and independently of the siding record.
    const comments = await getIssueComments(w2.issueId, db);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toMatch(/pulled into a siding/);

    expect(await getTrainSidingState(w1.workspaceId, db)).toBeUndefined();
    expect(await tagsOn(db, w1.issueId)).toEqual([]);

    // Next window, tip unchanged: held. Tip moved: re-admitted, tag cleared, count kept —
    // the same rule a conflict siding follows (`partitionSidedMembers` is #1192's own).
    const held = await partitionSidedMembers(members, "C:/nope", { database: db, sendTurn, getBranchHeadSha });
    expect(held.admitted.map((m) => m.workspaceId)).toEqual([w1.workspaceId]);
    expect(held.held.map((h) => h.member.workspaceId)).toEqual([w2.workspaceId]);
    expect(held.held[0].reason).toMatch(/still on siding 1/);

    shas.f2 = "w2-tip-2-after-fix";
    const readmitted = await partitionSidedMembers(members, "C:/nope", { database: db, sendTurn, getBranchHeadSha });
    expect(readmitted.held).toEqual([]);
    expect(readmitted.admitted.map((m) => m.workspaceId)).toEqual([w1.workspaceId, w2.workspaceId]);
    expect(await getTrainSidingState(w2.workspaceId, db)).toMatchObject({ sidings: 1, sidedBranchSha: null });
    expect(await tagsOn(db, w2.issueId)).toEqual([]);
  });

  it("advisory (sprint) and a failed review side nobody, so no siding row is ever written", async () => {
    const { db, dispose } = createTestDb();
    disposers.push(dispose);
    const { projectId, members } = await seedTrain(db, { repoPath: "C:/nope", posture: "sprint", branches: ["f1", "f2"] });
    const sendTurn = vi.fn();
    const base = { projectId, trainLabel: "q2", trainRef: "kanban/train/q2", baseBranch: "main", gateWorktree: "C:/nope/wt", repoPath: "C:/nope", members, thorough: false };

    await runTrainReview({ ...base, blocking: false }, { database: db, invoke: critical(1), buildContext: async () => null, sendTurn, getBranchHeadSha: async () => "x" });
    await runTrainReview({ ...base, blocking: true }, { database: db, invoke: async () => { throw new Error("reviewer down"); }, buildContext: async () => null, sendTurn, getBranchHeadSha: async () => "x" });

    for (const m of members) {
      expect(await getTrainSidingState(m.workspaceId, db)).toBeUndefined();
      expect(await tagsOn(db, m.issueId)).toEqual([]);
    }
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("without a session port the siding is still recorded — only the nudge is lost", async () => {
    const { db, dispose } = createTestDb();
    disposers.push(dispose);
    const { projectId, members } = await seedTrain(db, { repoPath: "C:/nope", posture: "fast", branches: ["f1", "f2"] });
    await runTrainReview(
      { projectId, trainLabel: "q3", trainRef: "kanban/train/q3", baseBranch: "main", gateWorktree: "C:/nope/wt", repoPath: "C:/nope", members, blocking: true, thorough: false },
      { database: db, invoke: critical(2), buildContext: async () => null, getBranchHeadSha: async () => "sha" },
    );
    expect(await getTrainSidingState(members[1].workspaceId, db)).toMatchObject({ sidings: 1, sidedBranchSha: "sha" });
  });
});

describe("train review → siding (#1194 + #1192, runner with real git)", () => {
  const git = (repoPath: string, args: string[]) => gitExecOrThrow(args, { cwd: repoPath });
  const tempRepos: string[] = [];
  const disposers: Array<() => void> = [];
  afterEach(() => {
    for (const d of disposers.splice(0)) d();
    while (tempRepos.length) {
      try { rmSync(tempRepos.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  async function commitOn(repoPath: string, branch: string, file: string, content: string) {
    await git(repoPath, ["checkout", "-q", branch]);
    writeFileSync(join(repoPath, file), content, "utf8");
    await git(repoPath, ["add", file]);
    await git(repoPath, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `feat: ${file}`]);
  }

  async function makeRepo(): Promise<string> {
    const repoPath = mkdtempSync(join(tmpdir(), "ak-train-review-siding-"));
    tempRepos.push(repoPath);
    await git(repoPath, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repoPath, "base.txt"), "base\n", "utf8");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "chore: base"]);
    for (const [b, f] of [["f1", "a.txt"], ["f2", "b.txt"], ["f3", "c.txt"]]) {
      await git(repoPath, ["branch", b]);
      await commitOn(repoPath, b, f, `${f}\n`);
    }
    await git(repoPath, ["checkout", "-q", "main"]);
    return repoPath;
  }

  it("sides the member the review blocks, withholds it next window, re-admits and lands it once its tip moves", async () => {
    const { db, dispose } = createTestDb();
    disposers.push(dispose);
    const repoPath = await makeRepo();
    const { members } = await seedTrain(db, { repoPath, posture: "fast", branches: ["f1", "f2", "f3"] });
    const [a, b, c] = members;

    // Only the reviewer's REPLY is canned; the review service, the siding service, the gate
    // worktree and the landing are all real. First window: #2 is blocking; afterwards: clean.
    let verdict = `{"summary":"s","findings":[{"member":"#2","severity":"MAJOR","file":"b.txt","message":"b.txt breaks the invariant"}]}`;
    const invoke = vi.fn(async () => verdict);
    const sendTurn = vi.fn().mockResolvedValue({ type: "sent" });
    const closed: string[] = [];
    const runner = createMergeTrainRunner({
      database: db,
      reconcileAlreadyMerged: async (id) => { closed.push(id); },
      sendTurn,
      reviewTrain: (args, deps) => runTrainReview(args, { ...deps, invoke, buildContext: async () => null }),
    });
    const service = createMergeQueueService({ database: db });
    const run = async (ids: string[]) => {
      const events = [];
      for await (const e of runner.runTrainStrategy(await service.computePlan(ids))) events.push(e);
      return events;
    };

    // Window 1: a + b. The review blocks b; a lands without it.
    const w1 = await run([a.workspaceId, b.workspaceId]);
    expect(w1).toContainEqual(expect.objectContaining({ type: "merged", workspaceId: a.workspaceId }));
    expect(w1).toContainEqual(expect.objectContaining({ type: "skipped", workspaceId: b.workspaceId, reason: expect.stringMatching(/sided by the train review/) }));
    expect(closed).toEqual([a.workspaceId]);
    expect(invoke).toHaveBeenCalledTimes(1);

    const f2Tip = (await git(repoPath, ["rev-parse", "f2"])).trim();
    const row = await getTrainSidingState(b.workspaceId, db);
    expect(row).toMatchObject({ sidings: 1, sidedBranchSha: f2Tip, cappedAt: null });
    expect(row?.conflictTrainTipSha).toMatch(SHA40);
    expect(await tagsOn(db, b.issueId)).toEqual([TRAIN_SIDING_TAG]);
    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(sendTurn.mock.calls[0][0]).toBe(b.workspaceId);
    expect(sendTurn.mock.calls[0][1]).toContain("b.txt breaks the invariant");
    // The landed member carries no siding memory.
    expect(await getTrainSidingState(a.workspaceId, db)).toBeUndefined();
    // b's branch was never rewritten and is not on main.
    expect((await git(repoPath, ["rev-parse", "f2"])).trim()).toBe(f2Tip);
    expect((await git(repoPath, ["branch", "--contains", f2Tip])).trim()).not.toMatch(/\bmain\b/);

    // Window 2: b again, tip unchanged — held out before any assembly, no review, no nudge.
    const w2 = await run([b.workspaceId]);
    expect(w2).toEqual([
      expect.objectContaining({ type: "skipped", workspaceId: b.workspaceId, reason: expect.stringMatching(/^train siding: still on siding 1/) }),
      expect.objectContaining({ type: "done", merged: [], failed: [], skipped: [b.workspaceId] }),
    ]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(sendTurn).toHaveBeenCalledTimes(1);

    // Window 3: the author pushed a fix (tip moved) and the reviewer is satisfied — b re-admits
    // with c, both land, and landing clears b's siding row and tag (the full reset).
    await commitOn(repoPath, "f2", "b.txt", "b fixed\n");
    await git(repoPath, ["checkout", "-q", "main"]);
    verdict = `{"summary":"clean","findings":[]}`;
    const w3 = await run([b.workspaceId, c.workspaceId]);
    expect(w3).toContainEqual(expect.objectContaining({ type: "merged", workspaceId: b.workspaceId }));
    expect(w3).toContainEqual(expect.objectContaining({ type: "merged", workspaceId: c.workspaceId }));
    expect(w3.find((e) => e.type === "skipped")).toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(await getTrainSidingState(b.workspaceId, db)).toBeUndefined();
    expect(await tagsOn(db, b.issueId)).toEqual([]);
    expect(closed).toEqual([a.workspaceId, b.workspaceId, c.workspaceId]);
  }, 240000);
});
