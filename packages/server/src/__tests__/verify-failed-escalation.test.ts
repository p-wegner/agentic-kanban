// @covers review-merge.merge.retry-backoff [workflow,state-transition,resilience]
/**
 * #1230 — `verify_failed` re-gated every tick with no backoff (defects 1 and 2 of the ticket).
 *
 * MEASURED: the pre-merge gate ran 31 times between 22:47 and 06:49 UTC on ONE commit of
 * workspace 75b824fe, every run failing the same deterministic guard, ~3 min each — ~1.8 h of
 * box time for zero information. These pin the ticket's acceptance criteria: two consecutive
 * identical `verify_failed` skips put the workspace in a backoff window the orchestrator's next
 * tick honours; the SECOND identical guard-only failure takes the workspace out of the loop
 * (backoff pinned at the ceiling, `readyForMerge` cleared, one issue comment naming the suite);
 * and an explicit merge request runs regardless and resets the count.
 */
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, workspaceMergeBackoff, workspaces } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import {
  MERGE_BACKOFF_MAX_ATTEMPTS,
  MERGE_BACKOFF_VERIFY_FAILED_BASE_MS,
  MERGE_BACKOFF_VERIFY_FAILED_CAP_MS,
  classifyMergeFailure,
  nextRetryDelayMs,
  shouldSkipMergeForBackoff,
} from "../services/merge-backoff.service.js";
import {
  DETERMINISTIC_GUARD_REPEATS,
  describeVerifyFailedSkip,
  escalateVerifyFailedSkip,
  verifyFailedSignatureKey,
} from "../services/verify-failed-escalation.js";
import { createAutoMergeOrchestrator } from "../startup/auto-merge-orchestrator.js";
import { getLatestIssueCommentByKind } from "../repositories/issue-comments.repository.js";
import { runWorkspaceMergeJob } from "../routes/workspace-merge-actions.js";

type Db = ReturnType<typeof createTestDb>["db"];

// A guard by the naming rule. Deliberately NOT the real nloc ring's file name: the always-run
// marker ratchet reads that helper's name as "uses the shared scanner" and would ask for a marker.
const GUARD = "packages/client/src/__tests__/exports-size-ratchet.test.ts";
const MIN = 60_000;
const REASON =
  "verify_failed: Pre-merge gate failed (verify) — merge withheld. failing suite(s): " +
  `${GUARD} [deterministic guard failure]. verify_script failed (exit 1): … Duration 118.4s\n[full verify log: C:\\tmp\\kanban-verify-ws.log]`;

async function seedWorkspace(db: Db, issueNumber = 1228) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "AI Reviewed", sortOrder: 2, isDefault: false, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber, title: `Issue ${issueNumber}`, priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: `feature/ak-${issueNumber}`,
    workingDir: `/repo/.worktrees/ws-${issueNumber}`, baseBranch: "master",
    isDirect: false, status: "idle", readyForMerge: true, mergedAt: null,
    provider: "claude", createdAt: now, updatedAt: now,
  });
  return { projectId, issueId, workspaceId, workingDir: `/repo/.worktrees/ws-${issueNumber}` };
}

function readBackoff(db: Db, workspaceId: string) {
  return db.select({ failures: workspaceMergeBackoff.failures, signature: workspaceMergeBackoff.signature, nextRetryAt: workspaceMergeBackoff.nextRetryAt })
    .from(workspaceMergeBackoff).where(eq(workspaceMergeBackoff.workspaceId, workspaceId)).then((r) => r[0]);
}

function readReady(db: Db, workspaceId: string) {
  return db.select({ readyForMerge: workspaces.readyForMerge }).from(workspaces).where(eq(workspaces.id, workspaceId)).then((r) => r[0]!.readyForMerge);
}

const skipFor = (ws: Awaited<ReturnType<typeof seedWorkspace>>, over: Partial<Parameters<typeof escalateVerifyFailedSkip>[0]> = {}) => ({
  workspaceId: ws.workspaceId,
  projectId: ws.projectId,
  workingDir: ws.workingDir,
  issueNumber: 1228,
  reason: REASON,
  failedSuites: [GUARD],
  guardFailure: false,
  ...over,
});

describe("verify_failed backoff schedule (#1230)", () => {
  it("classifies the queue's verify_failed skip as its own class with a 15/30/60/120/240-minute ramp", () => {
    expect(classifyMergeFailure(REASON)).toBe("verify_failed");
    expect(MERGE_BACKOFF_VERIFY_FAILED_BASE_MS).toBe(15 * MIN);
    expect(MERGE_BACKOFF_VERIFY_FAILED_CAP_MS).toBe(240 * MIN);
    expect([1, 2, 3, 4, 5, 6].map((n) => nextRetryDelayMs("verify_failed", n) / MIN)).toEqual([15, 30, 60, 120, 240, 240]);
    // The monitor path's prose keeps its generic ramp (pinned by merge-backoff.test.ts).
    expect(classifyMergeFailure("Pre-merge gate failed (verify) — merge withheld. 3 tests failed")).toBe("generic");
  });

  it("signs a failure by commit + suites, so the same red gate is identical and a new commit is fresh", () => {
    expect(verifyFailedSignatureKey("abc", ["b", "a"], REASON)).toBe("verify_failed|abc|a,b");
    expect(verifyFailedSignatureKey("abc", ["a", "b"], REASON)).toBe(verifyFailedSignatureKey("abc", ["b", "a"], REASON));
    expect(verifyFailedSignatureKey("def", ["a", "b"], REASON)).not.toBe(verifyFailedSignatureKey("abc", ["a", "b"], REASON));
    expect(verifyFailedSignatureKey("abc", [], REASON)).toBe(REASON);
  });

  it("the board log line names the failing file(s), never the verify tail", () => {
    const line = describeVerifyFailedSkip({ workspaceId: "ws-1", issueNumber: 1228, reason: REASON, failedSuites: [GUARD], guardFailure: true });
    expect(line).toBe(`skipped workspace ws-1 (#1228): verify_failed — failing suite(s): ${GUARD} [deterministic guard failure]`);
    expect(line).not.toContain("kanban-verify");
    const nameless = describeVerifyFailedSkip({ workspaceId: "ws-2", issueNumber: null, reason: "verify_failed: Pre-merge gate failed (verify) — tsc exploded\nmore", failedSuites: [] });
    expect(nameless).toBe("skipped workspace ws-2: verify_failed — no failing suite could be named; Pre-merge gate failed (verify) — tsc exploded");
  });
});

describe("two identical verify_failed skips back the workspace off the orchestrator's next tick (#1230)", () => {
  it("records both, the third tick skips it with a backoff reason, and a new commit starts a fresh count", async () => {
    const { db } = createTestDb();
    const ws = await seedWorkspace(db);
    const deps = { database: db, getBranchHeadSha: vi.fn(async () => "sha-1") };

    const first = await escalateVerifyFailedSkip(skipFor(ws), deps);
    expect(first).toEqual({ failures: 1, escalated: false });
    const second = await escalateVerifyFailedSkip(skipFor(ws), deps);
    expect(second).toEqual({ failures: 2, escalated: false });
    const row = await readBackoff(db, ws.workspaceId);
    expect(row?.failures).toBe(2);
    expect(row?.signature).toMatch(/^verify_failed\|/);
    // Second failure ⇒ the 30-minute step of the ramp.
    expect(new Date(row!.nextRetryAt!).getTime() - Date.now()).toBeGreaterThan(29 * MIN);

    // The orchestrator asks the backoff before a candidate reaches the train window.
    const decision = await shouldSkipMergeForBackoff({ wsId: ws.workspaceId, projectId: ws.projectId, workingDir: ws.workingDir }, { database: db, getBranchHeadSha: async () => "sha-1" });
    expect(decision.skip).toBe(true);
    expect(decision.reason).toMatch(/verify_failed, 2 identical failure/);
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { logged.push(String(line)); });
    try {
      const orchestrator = createAutoMergeOrchestrator({ database: db });
      expect(await orchestrator.findCompletedWorkspaceIds()).toEqual([]);
      // Once per reason, not once per tick.
      expect(await orchestrator.findCompletedWorkspaceIds()).toEqual([]);
    } finally {
      logSpy.mockRestore();
    }
    const holds = logged.filter((line) => line.includes("holding workspace") && line.includes(ws.workspaceId));
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatch(/merge backoff active \(verify_failed, 2 identical failure/);
    // Still ready — a plain (non-guard) failure only backs off, it does not need attention.
    expect(await readReady(db, ws.workspaceId)).toBe(true);

    // A new commit is a DIFFERENT failure by construction: the count restarts at 1.
    const moved = await escalateVerifyFailedSkip(skipFor(ws), { database: db, getBranchHeadSha: async () => "sha-2" });
    expect(moved.failures).toBe(1);
  });
});

describe("a deterministic guard failure is taken out of the loop after the second identical one (#1230)", () => {
  it("pins the backoff at the ceiling, clears readyForMerge and writes ONE comment naming the suite", async () => {
    const { db } = createTestDb();
    const ws = await seedWorkspace(db);
    const deps = { database: db, getBranchHeadSha: vi.fn(async () => "0f2e1546e7") };
    expect(DETERMINISTIC_GUARD_REPEATS).toBe(2);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = await escalateVerifyFailedSkip(skipFor(ws, { guardFailure: true }), deps);
      expect(first).toEqual({ failures: 1, escalated: false });
      expect(await readReady(db, ws.workspaceId)).toBe(true);
      expect(await getLatestIssueCommentByKind(ws.issueId, "gate-decision", db)).toBeFalsy();

      const second = await escalateVerifyFailedSkip(skipFor(ws, { guardFailure: true }), deps);
      expect(second).toEqual({ failures: 2, escalated: true });
    } finally {
      warnSpy.mockRestore();
    }

    // Needs-attention state: no longer ready, and the backoff no longer expires by waiting.
    expect(await readReady(db, ws.workspaceId)).toBe(false);
    expect((await readBackoff(db, ws.workspaceId))?.failures).toBe(MERGE_BACKOFF_MAX_ATTEMPTS);
    const decision = await shouldSkipMergeForBackoff({ wsId: ws.workspaceId, projectId: ws.projectId, workingDir: ws.workingDir }, { database: db, getBranchHeadSha: async () => "0f2e1546e7" });
    expect(decision.skip).toBe(true);
    expect(decision.reason).toMatch(/merge retries exhausted \(verify_failed/);

    // The comment names the suite and the commit, through the single write path.
    const comment = await getLatestIssueCommentByKind(ws.issueId, "gate-decision", db);
    expect(comment).toBeDefined();
    expect(comment!.body).toContain(GUARD);
    expect(comment!.body).toContain("0f2e1546");
    expect(comment!.workspaceId).toBe(ws.workspaceId);
    expect(JSON.parse(comment!.payload!)).toMatchObject({ mergeReason: "deterministic_guard_failure", failedSuites: [GUARD], failures: 2 });

    // The orchestrator's next tick leaves it alone.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await createAutoMergeOrchestrator({ database: db }).findCompletedWorkspaceIds()).toEqual([]);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("does not escalate a MIXED failure — a non-guard suite may still be a load artefact", async () => {
    const { db } = createTestDb();
    const ws = await seedWorkspace(db);
    const deps = { database: db, getBranchHeadSha: vi.fn(async () => "sha-1") };
    await escalateVerifyFailedSkip(skipFor(ws, { failedSuites: [GUARD, "packages/client/src/lib/x.test.ts"], guardFailure: false }), deps);
    const second = await escalateVerifyFailedSkip(skipFor(ws, { failedSuites: [GUARD, "packages/client/src/lib/x.test.ts"], guardFailure: false }), deps);
    expect(second).toEqual({ failures: 2, escalated: false });
    expect(await readReady(db, ws.workspaceId)).toBe(true);
    expect((await readBackoff(db, ws.workspaceId))?.failures).toBe(2);
  });
});

describe("an explicit merge request bypasses the backoff (#1230)", () => {
  it("POST /merge's job runs the merge regardless of an exhausted backoff, and resets it", async () => {
    const { db } = createTestDb();
    const ws = await seedWorkspace(db);
    const deps = { database: db, getBranchHeadSha: vi.fn(async () => "sha-1") };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await escalateVerifyFailedSkip(skipFor(ws, { guardFailure: true }), deps);
      await escalateVerifyFailedSkip(skipFor(ws, { guardFailure: true }), deps);
    } finally {
      warnSpy.mockRestore();
    }
    expect((await readBackoff(db, ws.workspaceId))?.failures).toBe(MERGE_BACKOFF_MAX_ATTEMPTS);

    const mergeWorkspaceDeduped = vi.fn(async () => ({ merged: true }));
    const { run } = runWorkspaceMergeJob(
      ws.workspaceId,
      { mergeWorkspaceDeduped } as unknown as Parameters<typeof runWorkspaceMergeJob>[1],
      { database: db },
    );
    await expect(run).resolves.toEqual({ merged: true });
    expect(mergeWorkspaceDeduped).toHaveBeenCalledTimes(1);
    // The explicit request is also the reset: the row is gone, the next tick starts fresh.
    expect(await readBackoff(db, ws.workspaceId)).toBeUndefined();
    const decision = await shouldSkipMergeForBackoff({ wsId: ws.workspaceId, projectId: ws.projectId, workingDir: ws.workingDir }, { database: db });
    expect(decision.skip).toBe(false);
  });
});
