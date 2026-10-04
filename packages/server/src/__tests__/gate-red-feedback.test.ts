// @covers review-merge.merge.retry-backoff [workflow,state-transition,resilience]
/**
 * #1293 — a red PRE-MERGE gate goes back to the builder.
 *
 * Measured on #1292: the gate failed a `@gate:always-run` guard, the board logged a backoff and
 * did nothing until a human sent the builder a turn. These pin the loop: a red gate that named
 * suites sends ONE turn per branch head, the second red (new commit) a second turn, the third
 * escalates as before; infra-class reds send nothing; and nothing here merges.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import { escalateVerifyFailedSkip } from "../services/verify-failed-escalation.js";
import {
  GATE_RED_MAX_FEEDBACK_TURNS,
  buildGateRedFeedbackPrompt,
  decideGateRedFeedback,
  resetAllGateRedFeedbackForTests,
  resetGateRedFeedback,
} from "../services/gate-red-feedback.js";
import { mergeWorkspaceWithFixFallback } from "../startup/monitor-cycle-actions.js";
import { PRE_MERGE_GATE_FAILURE_REASON } from "../services/workspace-merge-gate.js";
import { WorkspaceError } from "../services/workspace-internals.js";
import { RUN_GATE } from "../services/pre-merge-gate.service.js";
import { verifyLogPath } from "../services/verify-failure-summary.js";

type Db = ReturnType<typeof createTestDb>["db"];

const GUARD = "packages/server/src/__tests__/startup-persistence-boundary-ratchet.test.ts";
const REASON = `verify_failed: Pre-merge gate failed (verify) — merge withheld. failing suite(s): ${GUARD}`;

async function seedWorkspace(db: Db) {
  const now = new Date().toISOString();
  const projectId = randomUUID(), statusId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "T", repoPath: "/repo", repoName: "repo", defaultBranch: "master", createdAt: now, updatedAt: now });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "AI Reviewed", sortOrder: 2, isDefault: false, createdAt: now });
  await db.insert(issues).values({ id: issueId, issueNumber: 1293, title: "t", priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-1293", workingDir: "/repo/.worktrees/ws-1293", baseBranch: "master",
    isDirect: false, status: "idle", readyForMerge: true, mergedAt: null, provider: "claude", createdAt: now, updatedAt: now,
  });
  return { projectId, issueId, workspaceId, workingDir: "/repo/.worktrees/ws-1293" };
}

const readReady = (db: Db, workspaceId: string) =>
  db.select({ r: workspaces.readyForMerge }).from(workspaces).where(eq(workspaces.id, workspaceId)).then((rows) => rows[0]!.r);

const skipFor = (ws: Awaited<ReturnType<typeof seedWorkspace>>, over: Record<string, unknown> = {}) => ({
  workspaceId: ws.workspaceId, projectId: ws.projectId, workingDir: ws.workingDir, issueNumber: 1293,
  reason: REASON, failedSuites: [GUARD], guardFailure: true, ...over,
});

describe("decideGateRedFeedback (pure)", () => {
  const base = { failedSuites: [GUARD], headSha: "a", turnsSent: 0, lastTurnHeadSha: null };
  it("sends for a named suite, awaits on the same head, escalates once the cap is spent on a new head", () => {
    expect(decideGateRedFeedback(base)).toBe("send");
    expect(decideGateRedFeedback({ ...base, turnsSent: 1, lastTurnHeadSha: "a" })).toBe("await-builder");
    expect(decideGateRedFeedback({ ...base, headSha: "b", turnsSent: 1, lastTurnHeadSha: "a" })).toBe("send");
    expect(decideGateRedFeedback({ ...base, headSha: "c", turnsSent: GATE_RED_MAX_FEEDBACK_TURNS, lastTurnHeadSha: "b" })).toBe("cap-reached");
  });
  it("names nothing -> not the builder's to fix", () => {
    expect(decideGateRedFeedback({ ...base, failedSuites: [] })).toBe("not-actionable");
  });
});

describe("a red pre-merge gate sends the builder a turn (#1293)", () => {
  beforeEach(() => {
    resetAllGateRedFeedbackForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("one turn on the first red (not after the second identical one), none on a re-gate of the same head, a second on the next head, then attention", async () => {
    const { db } = createTestDb();
    const ws = await seedWorkspace(db);
    let head = "sha-1";
    const sendBuilderTurn = vi.fn(async () => ({}));
    const deps = { database: db, getBranchHeadSha: async () => head, sendBuilderTurn };

    const first = await escalateVerifyFailedSkip(skipFor(ws), deps);
    expect(first).toMatchObject({ escalated: false, feedbackTurn: 1 });
    expect(sendBuilderTurn).toHaveBeenCalledTimes(1);
    const [targetId, prompt] = sendBuilderTurn.mock.calls[0] as unknown as [string, string];
    expect(targetId).toBe(ws.workspaceId);
    expect(prompt).toContain(GUARD);
    expect(prompt).toContain(verifyLogPath(ws.workspaceId));
    expect(prompt).toContain("turn 1 of 2");

    // The backoff re-gates the same head: still exactly one turn, and NOT escalated (the builder is on it).
    const again = await escalateVerifyFailedSkip(skipFor(ws), deps);
    expect(again.escalated).toBe(false);
    expect(sendBuilderTurn).toHaveBeenCalledTimes(1);
    expect(await readReady(db, ws.workspaceId)).toBe(true);

    // The builder's new commit goes red again: second turn.
    head = "sha-2";
    expect(await escalateVerifyFailedSkip(skipFor(ws), deps)).toMatchObject({ escalated: false, feedbackTurn: 2 });
    expect(sendBuilderTurn).toHaveBeenCalledTimes(2);

    // Third distinct red: cap spent -> today's escalation (readyForMerge cleared), no third turn.
    head = "sha-3";
    const third = await escalateVerifyFailedSkip(skipFor(ws), deps);
    expect(third.escalated).toBe(true);
    expect(sendBuilderTurn).toHaveBeenCalledTimes(2);
    expect(await readReady(db, ws.workspaceId)).toBe(false);
  });

  it("a non-guard named suite also gets a turn, and escalates at the cap", async () => {
    const { db } = createTestDb();
    const ws = await seedWorkspace(db);
    let head = "h1";
    const sendBuilderTurn = vi.fn(async () => ({}));
    const deps = { database: db, getBranchHeadSha: async () => head, sendBuilderTurn };
    const skip = skipFor(ws, { failedSuites: ["packages/client/src/lib/x.test.ts"], guardFailure: false });
    await escalateVerifyFailedSkip(skip, deps);
    head = "h2";
    await escalateVerifyFailedSkip(skip, deps);
    head = "h3";
    expect((await escalateVerifyFailedSkip(skip, deps)).escalated).toBe(true);
    expect(sendBuilderTurn).toHaveBeenCalledTimes(2);
  });

  it("infra-class failures (no named suite) send no turn", async () => {
    const { db } = createTestDb();
    const ws = await seedWorkspace(db);
    const sendBuilderTurn = vi.fn(async () => ({}));
    for (const reason of ["verify_failed: verify_timeout after 1200s", "verify_failed: verify_infra_missing: pnpm not found", "verify_failed: exit 3221225786"]) {
      const result = await escalateVerifyFailedSkip(skipFor(ws, { reason, failedSuites: [], guardFailure: false }), {
        database: db, getBranchHeadSha: async () => "sha-1", sendBuilderTurn,
      });
      expect(result.feedbackTurn ?? null).toBeNull();
    }
    expect(sendBuilderTurn).not.toHaveBeenCalled();
  });

  it("an undeliverable turn (builder busy) is not counted and falls back to the old escalation rules", async () => {
    const { db } = createTestDb();
    const ws = await seedWorkspace(db);
    const sendBuilderTurn = vi.fn(async () => { throw new Error("409 busy"); });
    const deps = { database: db, getBranchHeadSha: async () => "sha-1", sendBuilderTurn };
    expect((await escalateVerifyFailedSkip(skipFor(ws), deps)).escalated).toBe(false);
    // Second identical guard failure with the channel still failing: today's rule stops the loop.
    expect((await escalateVerifyFailedSkip(skipFor(ws), deps)).escalated).toBe(true);
    // Delivered later: the first turn is still number 1.
    resetGateRedFeedback(ws.workspaceId);
    const ok = vi.fn(async () => ({}));
    expect(await escalateVerifyFailedSkip(skipFor(ws), { ...deps, sendBuilderTurn: ok })).toMatchObject({ feedbackTurn: 1 });
  });

  it("prompt names the suites and the log path", () => {
    const prompt = buildGateRedFeedbackPrompt({ workspaceId: "w", failedSuites: [GUARD], guardFailure: true, attempt: 2, cap: 2, logPath: "C:/tmp/x.log" });
    expect(prompt).toContain(GUARD);
    expect(prompt).toContain("C:/tmp/x.log");
    expect(prompt).toContain("turn 2 of 2");
  });
});

describe("the monitor path feeds the builder and still never merges a red gate (#638, #1293)", () => {
  beforeEach(() => {
    resetAllGateRedFeedbackForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const candidate = {
    wsId: "ws-1293", wsStatus: "idle", workingDir: null, isDirect: false, projectId: "proj-1", issueId: "iss-1",
    issueTitle: "t", issueNumber: 1293, issueStatusName: "In Review", baseBranch: "master", readyForMerge: true,
  };
  const logs = { conflictMsg: "conflict", successMsg: "ok" };
  const gateError = (data: Record<string, unknown>) =>
    new WorkspaceError("Pre-merge gate failed (verify) — merge withheld.", "CONFLICT", { mergeReason: PRE_MERGE_GATE_FAILURE_REASON, ...data });

  it("sends one turn naming the suites, and neither fix-and-merge nor a second merge runs", async () => {
    const { db } = createTestDb();
    const sendTurn = vi.fn(async () => {});
    const fixAndMerge = vi.fn(async () => {});
    const merge = vi.fn(async () => { throw gateError({ failedSuites: [GUARD], guardFailure: true }); });
    const actions = { launch: vi.fn(), delete: vi.fn(), updateBase: vi.fn(), merge, fixAndMerge, sendTurn };

    await mergeWorkspaceWithFixFallback(candidate as never, actions as never, () => {}, logs, RUN_GATE, { database: db });

    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect((sendTurn.mock.calls[0] as unknown as [string, string])[1]).toContain(GUARD);
    expect(fixAndMerge).not.toHaveBeenCalled();
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it("an infra-class withhold (no suite named) sends no turn", async () => {
    const { db } = createTestDb();
    const sendTurn = vi.fn(async () => {});
    const actions = { launch: vi.fn(), delete: vi.fn(), updateBase: vi.fn(), fixAndMerge: vi.fn(), sendTurn, merge: vi.fn(async () => { throw gateError({}); }) };
    await mergeWorkspaceWithFixFallback(candidate as never, actions as never, () => {}, logs, RUN_GATE, { database: db });
    expect(sendTurn).not.toHaveBeenCalled();
    expect(actions.fixAndMerge).not.toHaveBeenCalled();
  });
});
