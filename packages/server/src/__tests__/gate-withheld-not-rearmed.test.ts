/**
 * #1299 — (1) the #932 reconciler never re-arms readyForMerge for a head the review-exit gate just
 * withheld, and (2) a red check:arch (god-module gate, lint:arch) names FILES, which count as
 * builder-actionable: the builder gets exactly one turn for that head, carrying the file and the
 * gate message.
 *
 * Measured 2026-10-04 on #1298: `pre-merge gate failed (verify) ... [god-module gate] 1 file(s)
 * exceed the 1000-line hard ceiling` was followed seconds later by `[reconcile] review ... exited
 * clean but readyForMerge was never armed — arming it (#932)`, and no builder turn was sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("../db/index.js", () => ({ db: { select: vi.fn(), update: vi.fn() } }));
vi.mock("../services/butler-event-feed.js", () => ({ emitButlerSystemEvent: vi.fn() }));
vi.mock("@agentic-kanban/shared/lib/workflow-engine", () => ({
  syncCurrentNodeToStatus: vi.fn(),
  transitionIssueStatus: vi.fn(async () => {}),
}));
vi.mock("../repositories/workspace-status.repository.js", () => ({ setWorkspaceStatus: vi.fn(async () => true) }));

import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { reconcileStrandedReviews } from "../startup/stranded-review-reconciler.js";
import { markReviewExitGateWithheld } from "../startup/exit/gate-withheld-marker.js";
import { parseArchOffenders, withFailedSuites } from "../services/verify-failed-suites.js";
import { escalateVerifyFailedSkip } from "../services/verify-failed-escalation.js";
import { resetAllGateRedFeedbackForTests } from "../services/gate-red-feedback.js";
import type { BoardEvents } from "../services/board-events.js";
import type { SessionManager } from "../services/session.manager.js";
import type { GitService } from "../services/workspace-internals.js";

type Db = ReturnType<typeof createTestDb>["db"];

const GOD_FILE = "packages/server/src/startup/exit-workflow.ts";
const GOD_MODULE_OUTPUT = [
  "",
  "[god-module gate] 1 file(s) exceed the 1000-line hard ceiling.",
  "Decompose them (extract a cohesive sub-module, or split behind a facade barrel —",
  "see packages/shared/src/lib/git-service.ts / workflow-engine.ts / agent-stream-parser.ts):",
  `  ${GOD_FILE}`,
  "",
  "[god-module gate] FAILED.",
  "[full verify log: C:/tmp/kanban-verify-ws.log]",
].join("\n");
const GATE_MESSAGE = `verify_script failed (exit 1): ${GOD_MODULE_OUTPUT}`;

async function seedCleanReviewedWorkspace(db: Db) {
  const now = new Date().toISOString();
  const projectId = randomUUID(), statusId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "T", repoPath: "/repo", repoName: "repo", defaultBranch: "master", createdAt: now, updatedAt: now });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now });
  await db.insert(issues).values({ id: issueId, issueNumber: 1298, title: "t", priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-1298", workingDir: "/repo/.worktrees/ws-1298", baseBranch: "master",
    isDirect: false, status: "idle", readyForMerge: false, mergedAt: null, provider: "claude", createdAt: now, updatedAt: now,
  });
  await db.insert(sessions).values({ id: randomUUID(), workspaceId, status: "stopped", triggerType: "review", exitCode: "0", startedAt: now });
  return { projectId, issueId, workspaceId, workingDir: "/repo/.worktrees/ws-1298" };
}

const readReady = (db: Db, workspaceId: string) =>
  db.select({ r: workspaces.readyForMerge }).from(workspaces).where(eq(workspaces.id, workspaceId)).then((rows) => rows[0]!.r);

describe("#932 reconciler vs a withheld review-exit gate (#1299)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("stays unarmed after a clean review exit while the head is the withheld one, and arms once the head moves", async () => {
    const { db } = createTestDb();
    const ws = await seedCleanReviewedWorkspace(db);
    let head = "sha-red";
    const gitService = { revParse: async () => head } as unknown as GitService;
    await markReviewExitGateWithheld(
      { workspaceId: ws.workspaceId, issueId: ws.issueId, workingDir: ws.workingDir, message: GATE_MESSAGE },
      { database: db, gitService },
    );
    const deps = {
      database: db,
      getSessionManager: () => ({} as SessionManager),
      boardEvents: { broadcast: vi.fn() } as unknown as BoardEvents,
      reviewSessionIds: new Set<string>(),
      hasCommittedWork: async () => true,
      gitService,
    };

    expect(await reconcileStrandedReviews(deps)).toBe(0);
    expect(await readReady(db, ws.workspaceId)).toBe(false);

    // The builder's fix is a new head: no longer withheld, the #932 repair applies again.
    head = "sha-fixed";
    expect(await reconcileStrandedReviews(deps)).toBe(1);
    expect(await readReady(db, ws.workspaceId)).toBe(true);
  });
});

describe("a red check:arch goes back to the builder (#1299)", () => {
  beforeEach(() => {
    resetAllGateRedFeedbackForTests();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("parses the offending files out of god-module and dependency-cruiser output", () => {
    expect(parseArchOffenders(GOD_MODULE_OUTPUT)).toEqual([GOD_FILE]);
    expect(parseArchOffenders("  error services-bypass-repositories: packages/server/src/services/a.ts → packages/server/src/db/index.ts")).toEqual([
      "packages/server/src/services/a.ts",
    ]);
    expect(parseArchOffenders("[god-module gate] UNVERIFIED — typescript is not installed.\n  packages/x.ts")).toEqual([]);
  });

  it("a god-module red names its file and earns exactly ONE builder turn per head", async () => {
    const { db } = createTestDb();
    const ws = await seedCleanReviewedWorkspace(db);
    const gated = withFailedSuites({ passed: false, message: GATE_MESSAGE }, {});
    expect(gated.failedSuites).toEqual([GOD_FILE]);
    expect(gated.guardFailure).toBe(true);

    const sendBuilderTurn = vi.fn(async () => ({}));
    const skip = {
      workspaceId: ws.workspaceId, projectId: ws.projectId, workingDir: ws.workingDir, issueNumber: 1298,
      reason: `verify_failed: ${gated.message}`, failedSuites: gated.failedSuites, guardFailure: gated.guardFailure,
    };
    const deps = { database: db, getBranchHeadSha: async () => "sha-1", sendBuilderTurn };

    expect(await escalateVerifyFailedSkip(skip, deps)).toMatchObject({ escalated: false, feedbackTurn: 1 });
    // Auto-merge re-gates the same red head with backoff: still one turn, not escalated.
    expect((await escalateVerifyFailedSkip(skip, deps)).escalated).toBe(false);
    expect(sendBuilderTurn).toHaveBeenCalledTimes(1);
    const [, prompt] = sendBuilderTurn.mock.calls[0] as unknown as [string, string];
    expect(prompt).toContain(GOD_FILE);
    expect(prompt).toContain("1000-line hard ceiling");
  });
});
