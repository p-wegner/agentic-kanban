/**
 * #797 / #784 — the OBSERVABLE CONSEQUENCE of a synchronous foundational merge.
 *
 * `foundational-merge.service.test.ts` already covers the eligibility CLASSIFIER
 * (`isFoundationalBlocker`: IS / is NOT foundational). This test closes the
 * remaining `workflow`-dimension gap: it drives the REAL review-exit merge path
 * (`createWorkflowEngine().runWorkflowOnExit` → `handleReviewSessionExit`) against
 * a REAL temp git repo and asserts the actual outcome —
 *
 *   when a just-reviewed ticket is a foundational blocker, its branch is merged
 *   into the base branch SYNCHRONOUSLY (inline, before the exit handler resolves),
 *   so the base branch has actually advanced and a dependent cut from it afterwards
 *   sees a NON-EMPTY base — instead of the merge being deferred to the async 30s
 *   auto-merge-orchestrator tick (during which a dependent could be cut from the
 *   empty/stale pre-merge base, the #797/#784 bug).
 *
 * Mutation reasoning: the production code merges inline only inside the
 * `if (isFoundationalBlocker) await autoMerge(...)` branch. If that synchronous
 * foundational merge were removed, deferred, or made async (the regression), the
 * foundational case would fall into the "queued for scheduled auto-merge" else
 * branch instead — `autoMerge` would NOT run before `runWorkflowOnExit` resolves,
 * so `master` would still point at the empty pre-merge base and `scaffold.ts`
 * would be absent from it → the foundational assertions go RED. The non-foundational
 * case is the contrast: it MUST stay deferred (base unchanged), proving it is the
 * foundational classification — not merely "any approved review exit" — that
 * triggers the inline merge.
 *
 * The injected `autoMerge` dep IS the production merge mechanism's wiring point
 * (the real one in `index.ts` performs the same git merge); giving it a faithful
 * real `git merge` makes "base advanced" a genuine observable, not a call-shape spy.
 */

// Mock only the modules exit-workflow.ts loads at import time that would otherwise
// do real side effects / I/O. node:child_process is deliberately NOT mocked: git
// (hasCommittedChanges via the shared git-exec adapter, plus the injected autoMerge)
// runs for REAL against the temp repo so branch advancement is genuine.
vi.mock("../db/index.js", () => ({ db: {} }));
vi.mock("../services/git.service.js", () => ({
  prepareForReview: vi.fn(async () => ({ success: true, diffRef: "master", conflictingFiles: [], uncommittedChanges: [] })),
  commitPaths: vi.fn(async () => false),
}));
vi.mock("../services/butler-event-feed.js", () => ({ emitButlerSystemEvent: vi.fn() }));
vi.mock("../services/agent-settings.service.js", () => ({
  isMockProfile: vi.fn(() => false),
  toExecutorProvider: vi.fn((p: string) => p),
  MOCK_AGENT_COMMAND: "mock",
}));
vi.mock("../startup/review-helpers.js", () => ({
  buildReviewArgs: vi.fn(() => undefined),
  buildReviewPrompt: vi.fn(async () => ({ prompt: "review", model: undefined })),
  getEffectiveProfile: vi.fn(() => undefined),
  parseProviderPref: vi.fn(() => "claude"),
  applyWorkspaceProfileToPrefs: vi.fn((m: Map<string, string>) => m),
}));
// Auto-merge must be ENABLED so the review-exit path reaches the foundational branch.
vi.mock("../startup/merge-strategy.js", () => ({
  isAutomaticMergeEnabled: vi.fn(() => true),
}));
// Keep the smoke gate a deterministic no-op (no stack profile → no smoke check).
vi.mock("../services/stack-profile.service.js", () => ({
  getStackProfile: vi.fn(async () => ({})),
  buildSmokeCheck: vi.fn(() => null),
  // The review-exit path now calls the shared runPreMergeGate, which reads the verify_script pref
  // via verifyScriptPrefKey — no verify_script is set for this test's project, so the gate is a
  // clean no-op, but the export must exist on the mock.
  verifyScriptPrefKey: (projectId: string) => `verify_script_${projectId}`,
}));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { issueDependencies, issues, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkflowEngine } from "../startup/exit-workflow.js";

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.toString().trim());
    });
  });
}

async function commitFile(cwd: string, file: string, content: string, message: string): Promise<void> {
  await writeFile(join(cwd, file), content);
  await git(["add", "-A"], cwd);
  await git(["commit", "-m", message], cwd);
}

function makeBoardEvents() {
  return { broadcast: vi.fn(), broadcastActivity: vi.fn() };
}
function makeSessionManager() {
  return { startSession: vi.fn(async () => randomUUID()) };
}

describe("exit-workflow: foundational blocker merges SYNCHRONOUSLY so a dependent isn't cut from an empty base (#797/#784)", () => {
  // @covers review-merge.foundational.sync-merge [workflow]
  let db: ReturnType<typeof createTestDb>["db"];
  let repo: string;
  let worktree: string;
  let projectId: string;
  let inProgressId: string;
  let inReviewId: string;
  let backlogId: string;
  let doneId: string;
  const now = new Date(Date.now() - 60_000).toISOString();

  beforeEach(async () => {
    ({ db } = createTestDb());

    // --- Real git repo: an (almost) empty base + a feature branch that adds the scaffold.
    repo = await mkdtemp(join(tmpdir(), "kanban-foundational-repo-"));
    await git(["init"], repo);
    await git(["config", "user.email", "t@t.com"], repo);
    await git(["config", "user.name", "Test"], repo);
    // The PRE-merge base is intentionally "empty": it does NOT contain scaffold.ts.
    await commitFile(repo, "README.md", "placeholder base\n", "seed empty base");
    await git(["branch", "-M", "master"], repo).catch(() => {});

    // Foundational scaffold lives only on the feature branch (in a worktree).
    worktree = join(repo, "..", `kanban-foundational-wt-${Date.now()}`);
    await git(["worktree", "add", "-b", "feature/foundational", worktree, "master"], repo);
    await commitFile(worktree, "scaffold.ts", "export const SCAFFOLD = true;\n", "feat: add foundational scaffold");

    // --- DB: project + statuses ("Done" must be named exactly so it counts as terminal).
    projectId = randomUUID();
    inProgressId = randomUUID();
    inReviewId = randomUUID();
    backlogId = randomUUID();
    doneId = randomUUID();
    await db.insert(projects).values({
      id: projectId, name: "Test", repoPath: repo, repoName: "repo",
      defaultBranch: "master", createdAt: now, updatedAt: now,
    });
    await db.insert(projectStatuses).values([
      { id: inProgressId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now },
      { id: inReviewId, projectId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: now },
      { id: backlogId, projectId, name: "Backlog", sortOrder: 2, isDefault: false, createdAt: now },
      { id: doneId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
    ]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true }).catch(() => {});
    await rm(worktree, { recursive: true, force: true }).catch(() => {});
  });

  /** Seed the just-reviewed foundational workspace + its review session. */
  async function seedReviewedWorkspace(): Promise<{ issueId: string; workspaceId: string; reviewSessionId: string }> {
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const reviewSessionId = randomUUID();
    await db.insert(issues).values({
      id: issueId, issueNumber: 797, title: "Foundational scaffold",
      priority: "medium", sortOrder: 0, statusId: inReviewId,
      projectId, createdAt: now, updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId, issueId,
      branch: "feature/foundational",
      workingDir: worktree,
      baseBranch: "master",
      isDirect: false,
      status: "idle",
      readyForMerge: false,
      provider: "claude",
      createdAt: now, updatedAt: now,
    });
    await db.insert(sessions).values({
      id: reviewSessionId, workspaceId, status: "running",
      triggerType: "review", createdAt: now, updatedAt: now,
    });
    return { issueId, workspaceId, reviewSessionId };
  }

  /** A faithful real-git autoMerge: lands the branch on master and converges DB state, exactly as production autoMerge does. */
  function makeRealAutoMerge() {
    return vi.fn(async (workspace: { id: string; branch: string }, _projectId: string, issueId: string, doneStatusId: string | null, ts: string) => {
      await git(["merge", "--no-ff", workspace.branch, "-m", `merge ${workspace.branch}`], repo);
      const mergeSha = await git(["rev-parse", "master"], repo);
      await db.update(workspaces).set({ status: "closed", mergedAt: ts, mergeCommitSha: mergeSha, updatedAt: ts }).where(eq(workspaces.id, workspace.id));
      if (doneStatusId) await db.update(issues).set({ statusId: doneStatusId, updatedAt: ts }).where(eq(issues.id, issueId));
    });
  }

  it("lands the foundational branch on the base branch BEFORE the exit handler resolves, so a dependent sees a non-empty base", async () => {
    const { issueId, workspaceId, reviewSessionId } = await seedReviewedWorkspace();

    // An OPEN tier-1 dependent makes this issue a foundational blocker.
    const dependentId = randomUUID();
    await db.insert(issues).values({
      id: dependentId, issueNumber: 798, title: "tier-1 dependent",
      priority: "medium", sortOrder: 1, statusId: backlogId,
      projectId, createdAt: now, updatedAt: now,
    });
    await db.insert(issueDependencies).values({
      id: randomUUID(), issueId: dependentId, dependsOnId: issueId, type: "depends_on", createdAt: now,
    });

    const baseBefore = await git(["rev-parse", "master"], repo);
    // The pre-merge base must NOT already contain the scaffold (it is "empty").
    await expect(git(["cat-file", "-e", "master:scaffold.ts"], repo)).rejects.toThrow();

    const autoMerge = makeRealAutoMerge();
    const engine = createWorkflowEngine({
      sessionManager: makeSessionManager() as never,
      boardEvents: makeBoardEvents() as never,
      autoMerge: autoMerge as never,
      database: db as never,
    });
    engine.reviewSessionIds.add(reviewSessionId);

    // Drive the real review-exit path. When this awaited call RESOLVES the merge
    // must already have happened (synchronously) — no extra tick / orchestrator run.
    await engine.runWorkflowOnExit(workspaceId, reviewSessionId, 0);

    // OUTCOME 1: the base branch actually advanced.
    const baseAfter = await git(["rev-parse", "master"], repo);
    expect(baseAfter).not.toBe(baseBefore);

    // OUTCOME 2: the base now contains the scaffold — a dependent cut from master
    // at this point would see a NON-EMPTY base (the #797/#784 correctness property).
    await expect(git(["cat-file", "-e", "master:scaffold.ts"], repo)).resolves.toBe("");
    const scaffoldOnBase = await git(["show", "master:scaffold.ts"], repo);
    expect(scaffoldOnBase).toContain("SCAFFOLD");

    // OUTCOME 3: it was the SYNCHRONOUS merge (issue Done, workspace closed) by the
    // time the handler returned — not left ready-but-unmerged for the async tick.
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    expect(issue.statusId).toBe(doneId);
    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).not.toBeNull();
  });

  it("does NOT merge a non-foundational leaf synchronously — base is untouched and the merge is deferred to the scheduled orchestrator", async () => {
    const { issueId, workspaceId, reviewSessionId } = await seedReviewedWorkspace();
    // No dependents seeded → isFoundationalBlocker is false → must NOT merge inline.

    const baseBefore = await git(["rev-parse", "master"], repo);

    const autoMerge = makeRealAutoMerge();
    const engine = createWorkflowEngine({
      sessionManager: makeSessionManager() as never,
      boardEvents: makeBoardEvents() as never,
      autoMerge: autoMerge as never,
      database: db as never,
    });
    engine.reviewSessionIds.add(reviewSessionId);

    await engine.runWorkflowOnExit(workspaceId, reviewSessionId, 0);

    // The synchronous merge must NOT fire for a leaf: autoMerge untouched, base unchanged.
    expect(autoMerge).not.toHaveBeenCalled();
    const baseAfter = await git(["rev-parse", "master"], repo);
    expect(baseAfter).toBe(baseBefore);
    await expect(git(["cat-file", "-e", "master:scaffold.ts"], repo)).rejects.toThrow();

    // It WAS approved (readyForMerge) and deferred — workspace stays open, issue In Review.
    const [ws] = await db.select({ readyForMerge: workspaces.readyForMerge, status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.readyForMerge).toBe(true);
    expect(ws.status).not.toBe("closed");
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    expect(issue.statusId).toBe(inReviewId);
  });
});
