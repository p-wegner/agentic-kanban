import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";

/**
 * #1207 follow-up — the same-failure breaker must hold ONE branch, not the whole project, when
 * the repeating failure is that branch's own.
 *
 * MEASURED motivation: overnight 2026-09-26/27 three `gate failed for this branch alone (bisected
 * out of the train)` failures of ONE branch (#1253) paused auto-merge for the whole project, and
 * two green branches (#1261, #1262) sat idle all night until master happened to move.
 */

// The branch head / base tip reads, controllable per test (no real repo on disk).
const heads = new Map<string, string>();
vi.mock("@agentic-kanban/shared/lib/git-service", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    revParse: async (_repoPath: string, ref: string) => {
      const sha = heads.get(ref);
      if (!sha) throw new Error(`unknown ref ${ref}`);
      return sha;
    },
  };
});

const { createTestDb } = await import("./helpers/test-db.js");
const { createAutoMergeOrchestrator } = await import("../startup/auto-merge-orchestrator.js");
const { createBoardMonitorRoute } = await import("../routes/board-monitor.js");
const {
  AUTO_MERGE_BREAKER_THRESHOLD,
  BRANCH_ALONE_FAILURE_PREFIX,
  breakerIsPaused,
  classifyBreakerTrip,
  isBranchAloneFailure,
  readAutoMergeBreaker,
  recordAutoMergeGateFailure,
  recordBreakerFailure,
} = await import("../services/auto-merge-breaker.js");
const {
  BRANCH_HOLD_REASON_MARKER,
  decideBranchHoldRelease,
  listAutoMergeBranchHolds,
  releaseMovedAutoMergeBranchHolds,
} = await import("../services/auto-merge-branch-hold.js");
const { getMergeHold, setMergeHold } = await import("../repositories/merge-hold.repository.js");
const { describeAutoMergeBreakerStatus, getAutopilotStatus } = await import("../services/autopilot-status.service.js");

const branchAlone = (suite: string) => `${BRANCH_ALONE_FAILURE_PREFIX} (bisected out of the train): failing suite(s): ${suite} [deterministic guard failure]`;

beforeEach(() => {
  heads.clear();
  heads.set("main", "base0000base0000");
});

describe("recordBreakerFailure — which scope a streak trips (pure)", () => {
  const at = (n: number) => new Date(Date.UTC(2026, 8, 27, 1, n)).toISOString();

  it("the same branch-alone failure of ONE workspace holds that branch and never pauses the project", () => {
    let state = recordBreakerFailure(null, { signature: "s", workspaceId: "w1", attributedWorkspaceId: "w1" }, at(0));
    state = recordBreakerFailure(state, { signature: "s", workspaceId: "w1", attributedWorkspaceId: "w1" }, at(1));
    expect(classifyBreakerTrip(state)).toBeNull();
    state = recordBreakerFailure(state, { signature: "s", workspaceId: "w1", attributedWorkspaceId: "w1" }, at(2));
    expect(state.count).toBe(AUTO_MERGE_BREAKER_THRESHOLD);
    expect(classifyBreakerTrip(state)).toBe("branch");
    expect(state.branchHeldAt).toBe(at(2));
    expect(breakerIsPaused(state)).toBe(false);
  });

  it("the same signature on DIFFERENT branches is the project's — it pauses", () => {
    let state = recordBreakerFailure(null, { signature: "s", workspaceId: "w1", attributedWorkspaceId: "w1" }, at(0));
    state = recordBreakerFailure(state, { signature: "s", workspaceId: "w2", attributedWorkspaceId: "w2" }, at(1));
    state = recordBreakerFailure(state, { signature: "s", workspaceId: "w1", attributedWorkspaceId: "w1" }, at(2));
    expect(classifyBreakerTrip(state)).toBe("project");
    expect(state.attributedWorkspaceId).toBeNull();
  });

  it("one unattributed failure in the streak (a whole-train / base failure) makes it the project's", () => {
    let state = recordBreakerFailure(null, { signature: "s", workspaceId: "w1", attributedWorkspaceId: "w1" }, at(0));
    state = recordBreakerFailure(state, { signature: "s", workspaceId: "w1" }, at(1));
    state = recordBreakerFailure(state, { signature: "s", workspaceId: "w1", attributedWorkspaceId: "w1" }, at(2));
    expect(classifyBreakerTrip(state)).toBe("project");
  });

  it("only the branch-alone prefix is attributable", () => {
    expect(isBranchAloneFailure(branchAlone("x.test.ts"))).toBe(true);
    expect(isBranchAloneFailure("train gate failed — nothing landed: boom")).toBe(false);
  });
});

describe("decideBranchHoldRelease (pure)", () => {
  const ours = `${BRANCH_HOLD_REASON_MARKER} 3 consecutive gate runs failed`;

  it("keeps the hold while the head is unchanged or unreadable", () => {
    expect(decideBranchHoldRelease({ branchSha: "aaa" }, { mergeHoldReason: ours, workspaceOpen: true, branchSha: "aaa" })).toEqual({ action: "keep" });
    expect(decideBranchHoldRelease({ branchSha: "aaa" }, { mergeHoldReason: ours, workspaceOpen: true, branchSha: null })).toEqual({ action: "keep" });
  });

  it("releases, clearing the hold, when the head moves or the workspace closed", () => {
    expect(decideBranchHoldRelease({ branchSha: "aaa" }, { mergeHoldReason: ours, workspaceOpen: true, branchSha: "bbb" }))
      .toMatchObject({ action: "release", clearMergeHold: true, reason: expect.stringMatching(/branch head moved/) });
    expect(decideBranchHoldRelease({ branchSha: "aaa" }, { mergeHoldReason: ours, workspaceOpen: false, branchSha: null }))
      .toMatchObject({ action: "release", clearMergeHold: true });
  });

  it("never clears an operator's hold — only drops its own bookkeeping", () => {
    expect(decideBranchHoldRelease({ branchSha: "aaa" }, { mergeHoldReason: "waiting for the demo", workspaceOpen: true, branchSha: "bbb" }))
      .toMatchObject({ action: "release", clearMergeHold: false });
    expect(decideBranchHoldRelease({ branchSha: "aaa" }, { mergeHoldReason: undefined, workspaceOpen: true, branchSha: "bbb" }))
      .toMatchObject({ action: "release", clearMergeHold: false });
  });
});

// ── the persisted half ──────────────────────────────────────────────────────────────────

type Db = ReturnType<typeof createTestDb>["db"];

async function seedProject(db: Db) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: "/tmp/repo", repoName: "repo", defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "AI Reviewed", sortOrder: 0, isDefault: false, createdAt: now });
  return { projectId, statusId };
}

let issueNumber = 1250;
async function seedReady(db: Db, projectId: string, statusId: string) {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(issues).values({
    id: issueId, issueNumber: issueNumber++, title: "I", priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: `feature/${workspaceId}`, workingDir: `/tmp/wt/${workspaceId}`,
    baseBranch: "main", isDirect: false, status: "idle", readyForMerge: true, provider: "claude", createdAt: now, updatedAt: now,
  });
  heads.set(`feature/${workspaceId}`, `head-${workspaceId.slice(0, 8)}-1`);
  return workspaceId;
}

describe("the overnight 2026-09-26/27 shape: one bad branch, two green ones", () => {
  it("holds the bad branch, keeps the project merging, and releases the branch when its head moves", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    const bad = await seedReady(db, projectId, statusId);
    const green1 = await seedReady(db, projectId, statusId);
    const green2 = await seedReady(db, projectId, statusId);

    for (let i = 0; i < AUTO_MERGE_BREAKER_THRESHOLD; i++) {
      await recordAutoMergeGateFailure({ projectId, workspaceId: bad, message: branchAlone("codex-skills-parity.test.ts"), database: db });
    }

    // The project is NOT paused, and the streak was reset so the next branch starts fresh.
    expect(await readAutoMergeBreaker(projectId, db)).toBeNull();
    // The bad branch carries a breaker-placed merge hold, recorded at its current head.
    const hold = await getMergeHold(bad, db);
    expect(hold?.reason).toMatch(new RegExp(`^${BRANCH_HOLD_REASON_MARKER}`));
    const [bookkeeping] = await listAutoMergeBranchHolds(db, projectId);
    expect(bookkeeping).toMatchObject({ workspaceId: bad, branchSha: `head-${bad.slice(0, 8)}-1`, count: 3 });

    // The orchestrator keeps merging the rest: the green ones are candidates, the bad one is not,
    // and the window is not held with `breaker_paused`.
    const orchestrator = createAutoMergeOrchestrator({ database: db, checkBaseRedVeto: async () => null });
    const rows = await orchestrator.findCompletedWorkspaceRows();
    expect(rows.map((r) => r.workspaceId).sort()).toEqual([green1, green2].sort());
    await orchestrator.applyTrainWindow(rows, new Date().toISOString());
    expect(orchestrator.state.trainWindows.get(projectId)?.lastVerdict?.reason).not.toBe("breaker_paused");

    // The autopilot read says it is branch-scoped, and auto-merge is still enabled.
    const status = await getAutopilotStatus(projectId, {
      database: db,
      readMachineCapacity: async () => ({ hold: false, limitingFactor: null } as never),
      canDispatch: async () => ({ available: true }) as never,
      hasFleetOverflowCapacity: async () => false,
      quiesceHostHeld: async () => false,
    });
    expect(status.autoMerge.source).not.toBe("paused_same_failure");
    expect(status.autoMergeBreaker).toMatchObject({ scope: "branch", heldBranches: [{ workspaceId: bad }] });

    // An unchanged head keeps the hold…
    expect(await releaseMovedAutoMergeBranchHolds(db, () => undefined)).toEqual([]);
    // …the author pushes, and the next tick has the branch back.
    heads.set(`feature/${bad}`, `head-${bad.slice(0, 8)}-2`);
    const lines: string[] = [];
    expect(await releaseMovedAutoMergeBranchHolds(db, (l) => lines.push(l))).toEqual([bad]);
    expect(lines[0]).toMatch(/branch head moved/);
    expect(await getMergeHold(bad, db)).toBeUndefined();
    expect(await listAutoMergeBranchHolds(db)).toEqual([]);
    expect((await orchestrator.findCompletedWorkspaceRows()).map((r) => r.workspaceId)).toContain(bad);
  });

  it("the same branch-alone signature on two different branches still pauses the whole project", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    const w1 = await seedReady(db, projectId, statusId);
    const w2 = await seedReady(db, projectId, statusId);
    const message = branchAlone("shared-guard.test.ts");
    await recordAutoMergeGateFailure({ projectId, workspaceId: w1, message, database: db });
    await recordAutoMergeGateFailure({ projectId, workspaceId: w2, message, database: db });
    await recordAutoMergeGateFailure({ projectId, workspaceId: w1, message, database: db });

    const state = await readAutoMergeBreaker(projectId, db);
    expect(breakerIsPaused(state)).toBe(true);
    expect(await listAutoMergeBranchHolds(db)).toEqual([]);
    expect(describeAutoMergeBreakerStatus(state, []).scope).toBe("project");
  });

  it("an operator's hold is never released by the sweep, and resume drops only breaker holds", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    const w1 = await seedReady(db, projectId, statusId);
    const w2 = await seedReady(db, projectId, statusId);
    for (let i = 0; i < AUTO_MERGE_BREAKER_THRESHOLD; i++) {
      await recordAutoMergeGateFailure({ projectId, workspaceId: w1, message: branchAlone("a.test.ts"), database: db });
    }
    for (let i = 0; i < AUTO_MERGE_BREAKER_THRESHOLD; i++) {
      await recordAutoMergeGateFailure({ projectId, workspaceId: w2, message: branchAlone("b.test.ts"), database: db });
    }
    // The operator takes over w2's hold with their own reason, then w2's head moves.
    await setMergeHold(w2, { reason: "waiting for the demo", heldAt: new Date().toISOString() }, db);
    heads.set(`feature/${w2}`, "moved");
    await releaseMovedAutoMergeBranchHolds(db, () => undefined);
    expect((await getMergeHold(w2, db))?.reason).toBe("waiting for the demo");

    const router = createBoardMonitorRoute(db, {});
    const res = await router.request(`/${projectId}/auto-merge/resume`, { method: "POST" });
    expect(await res.json()).toMatchObject({ ok: true, releasedBranchHolds: [w1] });
    expect(await getMergeHold(w1, db)).toBeUndefined();
    expect((await getMergeHold(w2, db))?.reason).toBe("waiting for the demo");
  });
});
