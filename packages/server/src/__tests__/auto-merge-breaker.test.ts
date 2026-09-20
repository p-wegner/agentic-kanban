import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, runtimeState, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createAutoMergeOrchestrator } from "../startup/auto-merge-orchestrator.js";
import { createBoardMonitorRoute } from "../routes/board-monitor.js";
import {
  AUTO_MERGE_BREAKER_THRESHOLD,
  SETUP_BLOCKED_SIGNATURE,
  autoMergeBreakerKey,
  breakerIsPaused,
  normalizeFailureSignature,
  parseBreakerState,
  readAutoMergeBreaker,
  recordAutoMergeGateFailure,
  recordBreakerFailure,
  shouldClearBreaker,
  writeAutoMergeBreaker,
} from "../services/auto-merge-breaker.js";
import { getAutopilotStatus } from "../services/autopilot-status.service.js";

/**
 * #1207 — auto-merge must stop retrying an infrastructure failure no retry can fix.
 *
 * MEASURED motivation: fixture projects under `exp/` failed every 30s window on the SAME error
 * (`Der Befehl "tsc" ist entweder falsch geschrieben...`, or an install failure behind an
 * `npm warn` banner), each retry an install plus a typecheck on a shared 16-core box.
 */

describe("normalizeFailureSignature (#1207)", () => {
  it("prefers the gate's own setup-blocked classification over the localized shell text", () => {
    // The German cmd.exe wording #1092 added to the gate's own matcher.
    expect(normalizeFailureSignature('Der Befehl "tsc" ist entweder falsch geschrieben oder\nkonnte nicht gefunden werden.'))
      .toBe(SETUP_BLOCKED_SIGNATURE);
    expect(normalizeFailureSignature("Error: Cannot find module 'vitest/config'")).toBe(SETUP_BLOCKED_SIGNATURE);
    // …so the same broken install reads as ONE signature whatever tool it happens to name.
    expect(normalizeFailureSignature("'depcruise' is not recognized as an internal or external command"))
      .toBe(normalizeFailureSignature("Cannot find module 'typescript'"));
  });

  it("skips warning banners — otherwise every failure on this box signs as `npm warn`", () => {
    const message = 'npm warn Unknown user config "store-dir"\nnpm warn Unknown user config "verify-store-integrity"\n\nassertion failed: 3 tests failed in board.test.ts';
    expect(normalizeFailureSignature(message)).toBe("assertion failed: 3 tests failed in board.test.ts");
  });

  it("trims to a comparable length and never returns empty", () => {
    expect(normalizeFailureSignature("x".repeat(500))).toHaveLength(120);
    expect(normalizeFailureSignature("   \n\n  ")).toBe("unknown failure");
  });
});

describe("recordBreakerFailure / shouldClearBreaker (#1207)", () => {
  const at = (n: number) => new Date(Date.UTC(2026, 8, 20, 12, n)).toISOString();

  it("pauses on the Nth identical failure and not before", () => {
    let state = recordBreakerFailure(null, { signature: "boom" }, at(0));
    expect(state).toMatchObject({ count: 1, since: at(0) });
    expect(breakerIsPaused(state)).toBe(false);

    state = recordBreakerFailure(state, { signature: "boom" }, at(1));
    expect(breakerIsPaused(state)).toBe(false);

    state = recordBreakerFailure(state, { signature: "boom" }, at(2));
    expect(state.count).toBe(AUTO_MERGE_BREAKER_THRESHOLD);
    expect(state.pausedAt).toBe(at(2));
    // The streak's start is preserved, and a later failure does not re-stamp the pause.
    expect(recordBreakerFailure(state, { signature: "boom" }, at(9))).toMatchObject({ count: 4, since: at(0), pausedAt: at(2) });
  });

  it("a DIFFERENT signature resets the count — three different failures is progress, not a loop", () => {
    let state = recordBreakerFailure(null, { signature: "a" }, at(0));
    state = recordBreakerFailure(state, { signature: "a" }, at(1));
    state = recordBreakerFailure(state, { signature: "b" }, at(2));
    expect(state).toMatchObject({ signature: "b", count: 1, since: at(2) });
    expect(breakerIsPaused(state)).toBe(false);
  });

  it("clears when the base sha moves or the failing workspace's setup verdict changes", () => {
    const paused = recordBreakerFailure(
      recordBreakerFailure(recordBreakerFailure(null, { signature: "s", baseSha: "aaa", workspaceId: "w1", setupVerdict: "failed" }, at(0)),
        { signature: "s", baseSha: "aaa", workspaceId: "w1", setupVerdict: "failed" }, at(1)),
      { signature: "s", baseSha: "aaa", workspaceId: "w1", setupVerdict: "failed" }, at(2));

    expect(shouldClearBreaker(paused, { baseSha: "aaa", setupVerdict: "failed" })).toBeNull();
    expect(shouldClearBreaker(paused, { baseSha: "bbb", setupVerdict: "failed" })).toMatch(/base sha moved/);
    expect(shouldClearBreaker(paused, { baseSha: "aaa", setupVerdict: "succeeded" })).toMatch(/setup verdict/);
    // An UNKNOWN current value is not evidence anything changed.
    expect(shouldClearBreaker(paused, {})).toBeNull();
  });

  it("a malformed stored row degrades to no breaker rather than throwing in the loop", () => {
    expect(parseBreakerState("not json")).toBeNull();
    expect(parseBreakerState(JSON.stringify({ signature: 1 }))).toBeNull();
    expect(parseBreakerState(null)).toBeNull();
  });
});

// ── the orchestrator half ───────────────────────────────────────────────────────────────

async function seedProject(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: "/tmp/repo", repoName: "repo", defaultBranch: "main",
    createdAt: now, updatedAt: now,
  });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "AI Reviewed", sortOrder: 0, isDefault: false, createdAt: now,
  });
  return { projectId, statusId };
}

let issueNumber = 500;
async function seedReady(db: ReturnType<typeof createTestDb>["db"], projectId: string, statusId: string) {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(issues).values({
    id: issueId, issueNumber: issueNumber++, title: "I", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: `feature/${workspaceId}`, workingDir: `/tmp/wt/${workspaceId}`,
    baseBranch: "main", isDirect: false, status: "idle", readyForMerge: true, provider: "claude",
    createdAt: now, updatedAt: now,
  });
  return workspaceId;
}

describe("auto-merge orchestrator honours the circuit breaker (#1207)", () => {
  it("a paused project holds its window with verdict breaker_paused instead of releasing", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    for (let i = 0; i < 4; i++) await seedReady(db, projectId, statusId);
    await writeAutoMergeBreaker(projectId, {
      signature: SETUP_BLOCKED_SIGNATURE, count: 3, since: new Date().toISOString(),
      pausedAt: new Date().toISOString(), baseSha: "aaa", workspaceId: null, setupVerdict: null,
    }, db);

    const orchestrator = createAutoMergeOrchestrator({ database: db, checkBaseRedVeto: async () => null });
    const rows = await orchestrator.findCompletedWorkspaceRows();
    const released = await orchestrator.applyTrainWindow(rows, new Date().toISOString());

    expect(released).toEqual([]);
    expect(orchestrator.state.trainWindows.get(projectId)?.lastVerdict).toEqual({ release: false, reason: "breaker_paused" });
  });

  it("three identical failures pause the project; a fourth window does not gate", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    for (let i = 0; i < 4; i++) await seedReady(db, projectId, statusId);
    const orchestrator = createAutoMergeOrchestrator({ database: db, checkBaseRedVeto: async () => null });

    const message = 'npm warn Unknown user config "store-dir"\nDer Befehl "tsc" ist entweder falsch geschrieben oder\nkonnte nicht gefunden werden.';
    for (let i = 0; i < 3; i++) {
      await recordAutoMergeGateFailure({ projectId, workspaceId: null, message, database: db });
    }
    const state = await readAutoMergeBreaker(projectId, db);
    expect(state).toMatchObject({ signature: SETUP_BLOCKED_SIGNATURE, count: 3 });
    expect(breakerIsPaused(state)).toBe(true);

    const rows = await orchestrator.findCompletedWorkspaceRows();
    expect(await orchestrator.applyTrainWindow(rows, new Date().toISOString())).toEqual([]);
  });

  it("the autopilot read reports paused_same_failure even though every preference says enabled", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);
    await writeAutoMergeBreaker(projectId, {
      signature: "boom", count: 3, since: new Date().toISOString(), pausedAt: new Date().toISOString(),
    }, db);

    const status = await getAutopilotStatus(projectId, {
      database: db,
      readMachineCapacity: async () => ({ hold: false, limitingFactor: null } as never),
      canDispatch: async () => ({ available: true }) as never,
      hasFleetOverflowCapacity: async () => false,
      quiesceHostHeld: async () => false,
    });
    expect(status.autoMerge).toEqual({ enabled: false, source: "paused_same_failure" });
  });

  it("POST /:id/auto-merge/resume clears the breaker", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);
    await writeAutoMergeBreaker(projectId, {
      signature: "boom", count: 3, since: new Date().toISOString(), pausedAt: new Date().toISOString(),
    }, db);

    const router = createBoardMonitorRoute(db, {});
    const res = await router.request(`/${projectId}/auto-merge/resume`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, cleared: true });
    expect(await readAutoMergeBreaker(projectId, db)).toBeNull();
    const [row] = await db.select().from(runtimeState);
    expect(row).toBeUndefined();
    expect(autoMergeBreakerKey(projectId)).toBe(`auto_merge_breaker_${projectId}`);
  });
});
