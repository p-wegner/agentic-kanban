/**
 * Regression test for issue #960:
 * A workspace whose REVIEW session exits CLEAN while its workflow node is still the graph's
 * `start` node was silently stranded — `readyForMerge` withheld on the theory that the graph
 * would drive the next stage, and nothing ever did. Hit twice in one evening (#954 on
 * `Implement`, #959 on `Reproduce & Fix`); both needed a hand `POST /ready-for-merge`.
 *
 * `workspaces.currentNodeId` tracks the ISSUE's status. When the issue never transitioned to
 * "In Review", the node is still the start node — non-terminal, `statusName` "In Progress" —
 * which `graphOwnsPostExitReview` classified as graph-owned. A start node is where the BUILDER
 * works, so a REVIEW exiting there means the transition was missed, not that the graph is
 * mid-flow: `graphOwnsReviewSessionExit` therefore hands that case back to the legacy pipeline.
 *
 * The builder-exit half is deliberately unchanged and is asserted below — a BUILDER finishing
 * on the start node IS mid-flow (the agent calls `propose_transition`), so #997's hands-off
 * behaviour must survive this fix.
 */

// Mock modules exit-workflow.ts loads at import time (same set as the #629 review-exit suite).
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
// The pre-merge gate is not what this ticket is about — it runs a real verify build. Stub it
// PASSING so the assertion is squarely about whether the ownership guards let the exit reach it.
vi.mock("../services/merge-gate-evidence.js", () => ({
  runGateWithEvidence: vi.fn(async () => ({
    passed: true, stage: "verify", message: "ok", ranAt: new Date().toISOString(),
    moved: null, shasBefore: { branchSha: "aaa", baseSha: "bbb" },
  })),
}));
// `hasCommittedChanges` counts commits ahead with `git rev-list --count <base>..HEAD` (#365).
// Report ONE so the #629 zero-commit guard does not fire and mask this ticket's behaviour.
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
import { issues, preferences, projectStatuses, projects, sessions, workflowNodes, workflowTemplates, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { invalidatePreferencesCache } from "../repositories/preferences.repository.js";
import { createWorkflowEngine } from "../startup/exit-workflow.js";
import {
  describeWithheldReviewArm,
  graphOwnsPostExitReview,
  graphOwnsReviewSessionExit,
  REVIEW_STAGE_STATUS_NAME,
  reviewerMovedIssueToInProgress,
  START_NODE_TYPE,
} from "../startup/exit/workflow-ownership.js";

/** The two shapes actually observed on #954 and #959. */
const OBSERVED_START_NODES = [
  { name: "Implement", nodeType: START_NODE_TYPE, statusName: "In Progress" },
  { name: "Reproduce & Fix", nodeType: START_NODE_TYPE, statusName: "In Progress" },
];

describe("graphOwnsReviewSessionExit (#960)", () => {
  it("hands a clean review exit on the graph's start node back to the legacy pipeline", () => {
    for (const node of OBSERVED_START_NODES) {
      // The shared predicate still says "graph-owned" — that is correct for a BUILDER exit and
      // is exactly the classification that stranded these two workspaces on a REVIEW exit.
      expect(graphOwnsPostExitReview(node)).toBe(true);
      expect(graphOwnsReviewSessionExit(node)).toBe(false);
    }
  });

  it("holds regardless of what status the start node is mapped to", () => {
    // The node's statusName is incidental here: it is the start-node TYPE that says "this is
    // the builder's stage", so the rule must not depend on a particular status mapping.
    expect(graphOwnsReviewSessionExit({ nodeType: START_NODE_TYPE, statusName: null })).toBe(false);
    expect(graphOwnsReviewSessionExit({ nodeType: START_NODE_TYPE, statusName: "Backlog" })).toBe(false);
  });

  it("leaves every other #997/#757 case exactly as it was", () => {
    // Not workflow-managed / terminal / mapped to In Review — all already legacy-owned.
    expect(graphOwnsReviewSessionExit(null)).toBe(false);
    expect(graphOwnsReviewSessionExit(undefined)).toBe(false);
    expect(graphOwnsReviewSessionExit({ nodeType: "end", statusName: null })).toBe(false);
    expect(graphOwnsReviewSessionExit({ nodeType: "normal", statusName: REVIEW_STAGE_STATUS_NAME })).toBe(false);
    // A mid-flow non-start stage stays graph-owned (#997): the graph does have a next stage.
    expect(graphOwnsReviewSessionExit({ nodeType: "normal", statusName: null })).toBe(true);
    expect(graphOwnsReviewSessionExit({ nodeType: "normal", statusName: "In Progress" })).toBe(true);
    expect(graphOwnsReviewSessionExit({ nodeType: "parallel-fork", statusName: null })).toBe(true);
  });

  it("does NOT change the BUILDER-exit predicate for a start node (#997 stays intact)", () => {
    // A builder finishing on the start node is genuinely mid-flow — the agent proposes the
    // transition to Review. Only the review-exit path gets the narrowing.
    expect(graphOwnsPostExitReview({ nodeType: START_NODE_TYPE, statusName: "In Progress" })).toBe(true);
  });
});

describe("reviewerMovedIssueToInProgress (#960)", () => {
  const started = "2026-08-31T10:00:00.000Z";

  it("reads a status write made DURING the review as the reviewer requesting changes", () => {
    expect(reviewerMovedIssueToInProgress("2026-08-31T10:05:00.000Z", started)).toBe(true);
    // Same instant counts as the reviewer's: the stamp cannot predate its own session.
    expect(reviewerMovedIssueToInProgress(started, started)).toBe(true);
  });

  it("reads a status write from BEFORE the review as the builder's original transition", () => {
    expect(reviewerMovedIssueToInProgress("2026-08-31T09:00:00.000Z", started)).toBe(false);
  });

  it("fails CLOSED on a missing or unparseable timestamp", () => {
    // Withholding is the pre-#960 behaviour; arming on no evidence would auto-merge an
    // unreviewed branch, so the unknown case must keep the withhold rather than the fix.
    expect(reviewerMovedIssueToInProgress(null, started)).toBe(true);
    expect(reviewerMovedIssueToInProgress(undefined, started)).toBe(true);
    expect(reviewerMovedIssueToInProgress("2026-08-31T09:00:00.000Z", null)).toBe(true);
    expect(reviewerMovedIssueToInProgress("not a date", started)).toBe(true);
  });
});

describe("describeWithheldReviewArm (#960)", () => {
  it("names the node, its type and its status so a withheld arm is visible in the log", () => {
    const text = describeWithheldReviewArm({ name: "Prepare", nodeType: "normal", statusName: "In Progress" });
    expect(text).toContain("Prepare");
    expect(text).toContain("normal");
    expect(text).toContain("In Progress");
  });

  it("degrades to placeholders rather than printing undefined", () => {
    const text = describeWithheldReviewArm({ name: null, nodeType: null, statusName: null });
    expect(text).not.toContain("undefined");
    expect(text).toContain("none");
  });
});

/**
 * The end-to-end #954/#959 shape, through the real exit engine: a review session exits 0 while
 * the ISSUE is still In Progress and the workspace still sits on the graph's start node.
 * Before #960 this returned twice over — first at the graph-ownership guard, then (had it got
 * past that) at the "reviewer flagged issues" In-Progress branch — leaving the workspace idle,
 * readyForMerge=false, and nothing scheduled to advance it.
 */
describe("exit-workflow: clean review on a start node arms readyForMerge (#960)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
    // Each case gets a fresh db; drop any prefs cached against the previous one so the
    // review_auto_fix cases below cannot leak into the default-pref cases.
    invalidatePreferencesCache();
  });

  /**
   * @param nodeType the workflow node the workspace is parked on when the review exits.
   * @param issueStatus which status the ISSUE holds — "In Progress" is the stranded shape.
   */
  async function seedReviewExitOnNode(
    nodeType: "start" | "normal",
    opts: {
      nodeName: string;
      nodeStatusName: string | null;
      issueStatus: "In Progress" | "In Review";
      /**
       * When did the ISSUE last get a status write, relative to the review session's start?
       * `"before"` (default) is the #954/#959 shape — the builder's own transition, untouched
       * by the review. `"during"` is the reviewer calling `move_issue(..., 'In Progress')` to
       * request changes, which stamps `statusChangedAt` even when the status does not change.
       */
      statusWrite?: "before" | "during";
    },
  ) {
    const now = new Date().toISOString();
    // The session starts a minute ago; the builder's status write predates it by an hour,
    // a reviewer's lands after it. Relative, never hardcoded ISO strings that age out.
    const sessionStartedAt = new Date(Date.now() - 60_000).toISOString();
    const statusChangedAt = opts.statusWrite === "during"
      ? new Date(Date.now() - 30_000).toISOString()
      : new Date(Date.now() - 3_600_000).toISOString();
    const projectId = randomUUID();
    const inProgressId = randomUUID();
    const inReviewId = randomUUID();
    const doneId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const reviewSessionId = randomUUID();
    const templateId = randomUUID();
    const nodeId = randomUUID();

    await db.insert(projects).values({
      id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
      defaultBranch: "master", createdAt: now, updatedAt: now,
    });
    await db.insert(projectStatuses).values([
      { id: inProgressId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now },
      { id: inReviewId, projectId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: now },
      { id: doneId, projectId, name: "Done", sortOrder: 2, isDefault: false, createdAt: now },
    ]);
    await db.insert(workflowTemplates).values({
      id: templateId, projectId, name: "Bug fix",
      ticketType: null, isDefault: false, isBuiltin: false, createdAt: now, updatedAt: now,
    });
    await db.insert(workflowNodes).values({
      id: nodeId, templateId, name: opts.nodeName, nodeType,
      statusName: opts.nodeStatusName, createdAt: now,
    });
    await db.insert(issues).values({
      id: issueId, issueNumber: 959, title: "Clean review on a start node",
      priority: "medium", sortOrder: 0,
      statusId: opts.issueStatus === "In Progress" ? inProgressId : inReviewId,
      workflowTemplateId: templateId,
      currentNodeId: nodeId,
      projectId, createdAt: now, updatedAt: now, statusChangedAt,
    });
    await db.insert(workspaces).values({
      id: workspaceId, issueId,
      branch: "feature/ak-959-test",
      workingDir: "/repo/.worktrees/ak-959-test",
      baseBranch: "master",
      isDirect: false,
      status: "idle",
      readyForMerge: false,
      provider: "claude",
      currentNodeId: nodeId,
      createdAt: now, updatedAt: now,
    });
    await db.insert(sessions).values({
      id: reviewSessionId, workspaceId,
      status: "running",
      triggerType: "review",
      startedAt: sessionStartedAt,
    });

    return { projectId, issueId, workspaceId, reviewSessionId };
  }

  function runExit(workspaceId: string, reviewSessionId: string) {
    const boardEvents = { broadcast: vi.fn(), broadcastActivity: vi.fn() };
    const engine = createWorkflowEngine({
      sessionManager: { startSession: vi.fn(async () => randomUUID()) } as never,
      boardEvents: boardEvents as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });
    engine.reviewSessionIds.add(reviewSessionId);
    return engine.runWorkflowOnExit(workspaceId, reviewSessionId, 0).then(() => boardEvents);
  }

  it("arms readyForMerge for the #959 shape: clean review, issue In Progress, node still the start node", async () => {
    const { workspaceId, reviewSessionId, projectId } = await seedReviewExitOnNode("start", {
      nodeName: "Reproduce & Fix", nodeStatusName: "In Progress", issueStatus: "In Progress",
    });

    const boardEvents = await runExit(workspaceId, reviewSessionId);

    const [ws] = await db.select({ readyForMerge: workspaces.readyForMerge })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.readyForMerge).toBe(true);
    expect(boardEvents.broadcast).toHaveBeenCalledWith(projectId, "workspace_ready_for_merge");
  });

  it("arms readyForMerge for the #954 shape too (`Implement` start node)", async () => {
    const { workspaceId, reviewSessionId } = await seedReviewExitOnNode("start", {
      nodeName: "Implement", nodeStatusName: "In Progress", issueStatus: "In Progress",
    });

    await runExit(workspaceId, reviewSessionId);

    const [ws] = await db.select({ readyForMerge: workspaces.readyForMerge })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.readyForMerge).toBe(true);
  });

  it("still withholds — and now says why — on a genuinely mid-flow graph stage (#997 intact)", async () => {
    const { workspaceId, reviewSessionId, projectId } = await seedReviewExitOnNode("normal", {
      nodeName: "Prepare", nodeStatusName: null, issueStatus: "In Progress",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const boardEvents = await runExit(workspaceId, reviewSessionId);

    const [ws] = await db.select({ readyForMerge: workspaces.readyForMerge })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.readyForMerge).toBe(false);
    expect(boardEvents.broadcast).not.toHaveBeenCalledWith(projectId, "workspace_ready_for_merge");
    // The "Done when" half: the withheld arm must NAME the node, so this is visible in the
    // server log without a DB query. That silence is what hid #954/#959 for an evening.
    const withheld = log.mock.calls.map((c) => String(c[0])).filter((line) => line.includes("withholding readyForMerge"));
    expect(withheld).toHaveLength(1);
    expect(withheld[0]).toContain("Prepare");
    log.mockRestore();
  });

  it("does NOT arm when the reviewer itself moved the issue to In Progress on the start node", async () => {
    // The non-auto-fix reviewer's ONLY changes-requested channel is `move_issue(…, 'In
    // Progress')` — and on the start node the issue is already In Progress, so the resulting
    // state is byte-identical to the #954/#959 stranded shape apart from WHEN the status was
    // written. Arming here would auto-merge a branch whose reviewer just found a CRITICAL.
    const { workspaceId, reviewSessionId, projectId } = await seedReviewExitOnNode("start", {
      nodeName: "Reproduce & Fix", nodeStatusName: "In Progress", issueStatus: "In Progress",
      statusWrite: "during",
    });

    // The hazard only exists in NON-auto-fix mode: with `review_auto_fix` on (the default) a
    // reviewer that finds issues fixes and commits them, so a clean exit SHOULD arm. Off, it
    // is told to report and edit nothing — the status move is then the whole verdict.
    await db.insert(preferences).values({ key: "review_auto_fix", value: "false", updatedAt: new Date().toISOString() });
    invalidatePreferencesCache();

    const boardEvents = await runExit(workspaceId, reviewSessionId);

    const [ws] = await db.select({ readyForMerge: workspaces.readyForMerge })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.readyForMerge).toBe(false);
    expect(boardEvents.broadcast).not.toHaveBeenCalledWith(projectId, "workspace_ready_for_merge");
  });

  it("still arms the #954/#959 shape in non-auto-fix mode when the reviewer did NOT touch the status", async () => {
    // The other half of the same pref: with review_auto_fix off, a review that changed nothing
    // must still arm — otherwise the fix would only work in the default configuration.
    const { workspaceId, reviewSessionId } = await seedReviewExitOnNode("start", {
      nodeName: "Implement", nodeStatusName: "In Progress", issueStatus: "In Progress",
    });
    await db.insert(preferences).values({ key: "review_auto_fix", value: "false", updatedAt: new Date().toISOString() });
    invalidatePreferencesCache();

    await runExit(workspaceId, reviewSessionId);

    const [ws] = await db.select({ readyForMerge: workspaces.readyForMerge })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.readyForMerge).toBe(true);
  });

  it("keeps the #757 In-Review-node behaviour: still arms", async () => {
    const { workspaceId, reviewSessionId } = await seedReviewExitOnNode("normal", {
      nodeName: "Review", nodeStatusName: REVIEW_STAGE_STATUS_NAME, issueStatus: "In Review",
    });

    await runExit(workspaceId, reviewSessionId);

    const [ws] = await db.select({ readyForMerge: workspaces.readyForMerge })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.readyForMerge).toBe(true);
  });
});
