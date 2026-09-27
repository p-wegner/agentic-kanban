/**
 * #1260: under a posture whose merge path gates anyway, the review-exit gate runs the typecheck
 * only and the test gate runs ONCE, at merge.
 *
 * Measured on the stable board 2026-09-26 under `flow`: every ticket paid a solo 25-40 min gate
 * at review-exit, then the merge train gated again, and the solo verdict was discarded whenever
 * the base moved (#243). The fix must hold three properties, and each has a case below:
 *  1. deferring postures run no test step at review-exit, and `readyForMerge` is still armed;
 *  2. the evidence they persist can never be read as a passed test gate, so the merge path
 *     runs the real gate (monitor: `ranAt`+`stage` required; HTTP: `reusePersistedGateVerdict`;
 *     foundational sync merge: `token` null -> `RUN_GATE`);
 *  3. `strict`/`standard` call the full gate exactly as before.
 */

// Mock modules exit-workflow.ts loads at import time (same set as the #960 review-exit suite).
vi.mock("../db/index.js", () => ({ db: {} }));
vi.mock("../services/git.service.js", () => ({
  prepareForReview: vi.fn(async () => ({ success: true, diffRef: "master", conflictingFiles: [], uncommittedChanges: [] })),
}));
vi.mock("../services/butler-event-feed.js", () => ({ emitButlerSystemEvent: vi.fn() }));
vi.mock("../services/agent-settings.service.js", () => ({
  applyWorkspaceProfileToPrefs: vi.fn((m: Map<string, string>) => m),
  resolveWorkspaceLaunchSettings: vi.fn(() => ({
    agentCommand: undefined, agentArgs: undefined, profile: undefined,
    provider: "claude", resumeWithNewModel: false, permissionPromptTool: undefined,
  })),
  isMockProfile: vi.fn(() => false),
  toExecutorProvider: vi.fn((p: string) => p),
  MOCK_AGENT_COMMAND: "mock",
}));
vi.mock("../services/review.service.js", async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  buildReviewPrompt: vi.fn(async () => ({ prompt: "review", model: undefined })),
}));
vi.mock("../startup/merge-strategy.js", () => ({
  isAutomaticMergeEnabled: vi.fn(() => false),
}));
// The FULL gate: a spy that passes, so the assertions are about WHICH gate the exit ran.
vi.mock("../services/merge-gate-evidence.js", () => ({
  runGateWithEvidence: vi.fn(async () => ({
    passed: true, ran: true, stage: "verify", message: "pre-merge gate passed (tier: impact)",
    ranAt: new Date().toISOString(), moved: null, movedDetail: null,
    shasBefore: { branchSha: "aaa", baseSha: "bbb" }, token: null, durationMs: 1,
  })),
}));
// The typecheck run: a spy, so no real `pnpm typecheck` is spawned.
vi.mock("@agentic-kanban/shared/lib/setup-script", async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  runSetupScript: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));
// `hasCommittedChanges` counts commits ahead; report ONE so the #629 guard does not fire.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(
      (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) =>
        args[0] === "rev-list" ? cb(null, "1\n", "") : cb(null, "", ""),
    ),
  };
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, preferences, projectStatuses, projects, sessions, workspaceMergeGate, workspaces } from "@agentic-kanban/shared/schema";
import { runSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import { RISK_POSTURES } from "@agentic-kanban/shared/lib/risk-posture";
import type { RiskPosture, RiskPostureLevel } from "@agentic-kanban/shared/types";
import { createTestDb } from "./helpers/test-db.js";
import { invalidatePreferencesCache } from "../repositories/preferences.repository.js";
import { createWorkflowEngine } from "../startup/exit-workflow.js";
import { runGateWithEvidence } from "../services/merge-gate-evidence.js";
import { resolveRiskPosture, riskPosturePrefKey } from "../services/risk-posture.service.js";
import { stackProfilePrefKey } from "../services/stack-profile/persistence.js";
import { reusePersistedGateVerdict } from "../services/workspace-merge-gate.js";
import type { Database } from "../db/index.js";
import {
  buildReviewExitEvidence,
  REVIEW_EXIT_GATE_SOURCE,
  REVIEW_EXIT_TYPECHECK_ONLY_SOURCE,
  reviewExitDefersTestsToMerge,
  runReviewExitGate,
  type ReviewExitGate,
} from "../startup/exit/review-exit-gate.js";

const PID = "project-1";
const postureFor = (level: RiskPostureLevel): RiskPosture =>
  resolveRiskPosture(new Map([[riskPosturePrefKey(PID), level]]), PID);

describe("reviewExitDefersTestsToMerge (#1260)", () => {
  it("defers the test step for every posture whose merge path gates the tree, and never for strict/standard", () => {
    const deferring = RISK_POSTURES.filter((level) => reviewExitDefersTestsToMerge({ level }));
    expect(deferring.sort()).toEqual(["fast", "flow", "iterate", "sprint"]);
  });

  it("every deferring posture's summary names the skip (visibility rule)", () => {
    for (const level of RISK_POSTURES) {
      const summary = postureFor(level).summary;
      expect(summary.includes("review-exit gate is typecheck only"), level).toBe(reviewExitDefersTestsToMerge({ level }));
    }
  });
});

describe("runReviewExitGate (#1260)", () => {
  const workspace = { id: "ws-1", workingDir: "/repo/.worktrees/ws-1", baseBranch: "master" };
  const fullGate = vi.fn(async () => ({
    passed: true, ran: true, stage: "verify" as const, message: "full", ranAt: "2026-09-27T00:00:00.000Z",
    moved: null, movedDetail: null, shasBefore: { branchSha: "a", baseSha: "b" }, token: null, durationMs: 1,
  }));
  const typecheck = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));

  function run(level: RiskPostureLevel, overrides: Partial<Parameters<typeof runReviewExitGate>[0]> = {}) {
    return runReviewExitGate({
      workspace, projectId: PID, issueId: "issue-1", prefMap: new Map(), database: {} as Database,
      resolvePosture: async () => postureFor(level),
      readTypecheckCommand: async () => "pnpm typecheck",
      runTypecheck: typecheck,
      runFullGate: fullGate as never,
      ...overrides,
    });
  }

  beforeEach(() => {
    fullGate.mockClear();
    typecheck.mockClear();
  });

  it("flow: runs the typecheck only, no test gate, and mints NO token", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const gate = await run("flow");
    expect(fullGate).not.toHaveBeenCalled();
    expect(typecheck).toHaveBeenCalledWith("/repo/.worktrees/ws-1", "pnpm typecheck");
    expect(gate).toMatchObject({ passed: true, typecheckOnly: true, token: null, moved: null });
    // The log line and message name what was skipped and carry the posture summary.
    expect(gate.message).toContain("typecheck only");
    expect(gate.message).toContain("test step SKIPPED");
    expect(gate.message).toContain("[risk posture: flow:");
    expect(log.mock.calls.map((c) => String(c[0])).some((l) => l.includes("test step SKIPPED"))).toBe(true);
    log.mockRestore();
  });

  it("a red typecheck withholds, exactly as a red gate did", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    typecheck.mockResolvedValueOnce({ exitCode: 2, stdout: "src/a.ts(1,1): error TS2322", stderr: "" });
    const gate = await run("iterate");
    expect(gate.passed).toBe(false);
    expect(gate.message).toContain("error TS2322");
    expect(gate.token).toBeNull();
    vi.restoreAllMocks();
  });

  it("standard: the full gate with the same arguments as before, no typecheck-only run", async () => {
    const gate = await run("standard");
    expect(typecheck).not.toHaveBeenCalled();
    expect(fullGate).toHaveBeenCalledTimes(1);
    expect(fullGate).toHaveBeenCalledWith({ workspace, projectId: PID, source: "review-exit gate", database: {} });
    expect(gate.typecheckOnly).toBe(false);
  });

  it("strict: the full gate", async () => {
    await run("strict");
    expect(fullGate).toHaveBeenCalledTimes(1);
    expect(typecheck).not.toHaveBeenCalled();
  });

  it("falls back to the full gate when the project has no typecheck command", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await run("flow", { readTypecheckCommand: async () => null });
    expect(fullGate).toHaveBeenCalledTimes(1);
    expect(typecheck).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("fails CLOSED to the full gate when the posture cannot be resolved", async () => {
    await run("flow", { resolvePosture: async () => { throw new Error("db gone"); } });
    expect(fullGate).toHaveBeenCalledTimes(1);
    expect(typecheck).not.toHaveBeenCalled();
  });
});

describe("buildReviewExitEvidence (#1260)", () => {
  const base = {
    passed: true, ran: true, stage: "verify" as const, message: "m", ranAt: "2026-09-27T00:00:00.000Z",
    moved: null, movedDetail: null, shasBefore: {}, token: null, durationMs: 1,
  };

  it("a typecheck-only run records WHAT ran but no ranAt/stage, so it is never a test pass", () => {
    const evidence = buildReviewExitEvidence({ ...base, typecheckOnly: true } as ReviewExitGate, { branchSha: "a", baseSha: "b" });
    expect(evidence).toEqual({
      ranAt: null, stage: null, source: REVIEW_EXIT_TYPECHECK_ONLY_SOURCE, branchSha: null, baseSha: null, message: "m",
    });
  });

  it("a full gate records the same evidence as before #1260", () => {
    const evidence = buildReviewExitEvidence({ ...base, typecheckOnly: false } as ReviewExitGate, { branchSha: "a", baseSha: "b" });
    expect(evidence).toEqual({
      ranAt: "2026-09-27T00:00:00.000Z", stage: "verify", source: REVIEW_EXIT_GATE_SOURCE, branchSha: "a", baseSha: "b", message: "m",
    });
  });
});

describe("exit-workflow: review-exit gate by posture (#1260)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
    invalidatePreferencesCache();
    vi.mocked(runGateWithEvidence).mockClear();
    vi.mocked(runSetupScript).mockClear();
  });

  async function seedCleanReviewExit(level: RiskPostureLevel) {
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const inReviewId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const reviewSessionId = randomUUID();
    await db.insert(projects).values({
      id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
      defaultBranch: "master", createdAt: now, updatedAt: now,
    });
    await db.insert(projectStatuses).values([
      { id: randomUUID(), projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now },
      { id: inReviewId, projectId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: now },
      { id: randomUUID(), projectId, name: "Done", sortOrder: 2, isDefault: false, createdAt: now },
    ]);
    await db.insert(issues).values({
      id: issueId, issueNumber: 1260, title: "Review-exit gate", priority: "medium", sortOrder: 0,
      statusId: inReviewId, projectId, createdAt: now, updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId, issueId, branch: "feature/ak-1260-test", workingDir: "/repo/.worktrees/ak-1260-test",
      baseBranch: "master", isDirect: false, status: "idle", readyForMerge: false, provider: "claude",
      createdAt: now, updatedAt: now,
    });
    await db.insert(sessions).values({
      id: reviewSessionId, workspaceId, status: "running", triggerType: "review",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await db.insert(preferences).values([
      { key: riskPosturePrefKey(projectId), value: level, updatedAt: now },
      { key: stackProfilePrefKey(projectId), value: JSON.stringify({ stack: "node", typecheckCommand: "pnpm typecheck" }), updatedAt: now },
    ]);
    invalidatePreferencesCache();
    return { projectId, workspaceId, reviewSessionId };
  }

  async function runExit(workspaceId: string, reviewSessionId: string) {
    const engine = createWorkflowEngine({
      sessionManager: { startSession: vi.fn(async () => randomUUID()) } as never,
      boardEvents: { broadcast: vi.fn(), broadcastActivity: vi.fn() } as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });
    engine.reviewSessionIds.add(reviewSessionId);
    await engine.runWorkflowOnExit(workspaceId, reviewSessionId, 0);
  }

  async function readState(workspaceId: string) {
    const [ws] = await db.select({ readyForMerge: workspaces.readyForMerge }).from(workspaces).where(eq(workspaces.id, workspaceId));
    const [evidence] = await db.select().from(workspaceMergeGate).where(eq(workspaceMergeGate.workspaceId, workspaceId));
    return { readyForMerge: ws.readyForMerge, evidence };
  }

  it("flow: no test gate at review-exit, readyForMerge armed with typecheck-only evidence the merge path will not accept", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { workspaceId, reviewSessionId, projectId } = await seedCleanReviewExit("flow");

    await runExit(workspaceId, reviewSessionId);

    expect(runGateWithEvidence).not.toHaveBeenCalled();
    expect(runSetupScript).toHaveBeenCalledWith("/repo/.worktrees/ak-1260-test", "pnpm typecheck", expect.anything());
    const { readyForMerge, evidence } = await readState(workspaceId);
    expect(readyForMerge).toBe(true);
    expect(evidence).toMatchObject({ ranAt: null, stage: null, source: REVIEW_EXIT_TYPECHECK_ONLY_SOURCE, verificationKey: null });
    expect(evidence.message).toContain("typecheck only");

    // The merge path. Monitor: `gateTokenFromWorkspaceEvidence` mints a pass only from
    // `mergeGateRanAt && mergeGateStage` — both null here, so it returns RUN_GATE. HTTP merge:
    // the persisted-verdict reuse refuses it, so `runPreLockGate` runs the gate.
    expect(evidence.ranAt && evidence.stage).toBeFalsy();
    const reused = await reusePersistedGateVerdict({
      workspaceId, projectId, database: db as never,
      workspace: { id: workspaceId, workingDir: "/repo/.worktrees/ak-1260-test", baseBranch: "master" },
      readShas: async () => ({ branchSha: "aaa", baseSha: "bbb" }),
      readVerificationKey: async () => "any",
    });
    expect(reused).toBeNull();
    vi.restoreAllMocks();
  });

  it("standard: the full review-exit gate runs and its pass is recorded exactly as before", async () => {
    const { workspaceId, reviewSessionId } = await seedCleanReviewExit("standard");

    await runExit(workspaceId, reviewSessionId);

    expect(runGateWithEvidence).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runGateWithEvidence).mock.calls[0][0]).toMatchObject({ source: "review-exit gate" });
    expect(runSetupScript).not.toHaveBeenCalledWith(expect.anything(), "pnpm typecheck", expect.anything());
    const { readyForMerge, evidence } = await readState(workspaceId);
    expect(readyForMerge).toBe(true);
    expect(evidence).toMatchObject({ stage: "verify", source: "review-exit gate", branchSha: "aaa", baseSha: "bbb" });
    expect(evidence.ranAt).toBeTruthy();
  });
});
