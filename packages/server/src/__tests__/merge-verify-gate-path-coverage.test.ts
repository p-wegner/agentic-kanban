// @covers review-merge.gate.verify-smoke [error-handling,config,risk]
//
// Behaviour (#821): a configured verify/smoke pre-merge gate must FAIL the merge when the project's
// verify_script exits non-zero (and must PASS the land when it exits 0). Test 1 pins that GATE
// DECISION directly.
//
// HISTORY (#930): `runPreMergeGate` was originally wired ONLY into the in-process monitor's auto-merge
// paths (monitor-cycle.ts:247 / :323) and the review-exit handler (exit-workflow.ts:536). The
// MANUAL/operator merge body — POST /api/workspaces/:id/merge → mergeWorkspace() → doMerge() — did NOT
// call runPreMergeGate, so a hand-merge (or the merge_queue orchestrator, which also goes through
// mergeWorkspace) could land build/test/boot-UNVERIFIED code on a project that configured a verify
// gate. #930 CLOSED that gap: `doMerge` now runs the shared gate before landing (after OpenSpec/migration
// prevalidation, before executeWorkspaceMerge) and WITHHOLDS the merge on failure. The two manual-path
// tests below — which assert that gated behaviour — were `it.fails(...)` known-gap markers; now that the
// path gates, they are flipped to `it(...)`.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceMergeService } from "../services/workspace-merge.service.js";
import { activeMerges } from "../services/workspace-internals.js";
import { setPreference } from "../repositories/preferences.repository.js";
import { verifyScriptPrefKey } from "../services/stack-profile.service.js";

// The gate runs a real build via runSetupScript (and a real dev server via runSmokeCheck). Mock both
// boundaries so we force the verify outcome deterministically without spawning anything.
const runSetupScript = vi.fn();
const runSmokeCheck = vi.fn();
vi.mock("@agentic-kanban/shared/lib/setup-script", () => ({
  runSetupScript: (...args: unknown[]) => runSetupScript(...args),
}));
vi.mock("@agentic-kanban/shared/lib/smoke-check", () => ({
  runSmokeCheck: (...args: unknown[]) => runSmokeCheck(...args),
}));

const { runPreMergeGate } = await import("../services/pre-merge-gate.service.js");

// Isolate the module-level per-repoPath merge lock between tests (see workspace-merge-service.test.ts).
beforeEach(() => {
  activeMerges.clear();
  runSetupScript.mockReset();
  runSmokeCheck.mockReset();
});

function makeGit(overrides: Partial<Record<string, (...a: unknown[]) => unknown>> = {}) {
  return {
    getDiff: vi.fn(async () => ""),
    getDiffFromRepo: vi.fn(async () => ""),
    revParse: vi.fn(async (_repo: string, ref: string) => {
      if (ref === "feature/ak-821-test") return "feature-sha";
      if (ref === "master") return "master-sha-before";
      return "merge-commit-sha";
    }),
    isAncestor: vi.fn(async () => false),
    mergeBranch: vi.fn(async () => "Merge made by the 'ort' strategy."),
    detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
    syncBranchToHead: vi.fn(async () => false),
    removeWorktree: vi.fn(async () => {}),
    deleteBranch: vi.fn(async () => {}),
    getChangedFilesBetween: vi.fn(async () => []),
    getCurrentBranch: vi.fn(async () => "master"),
    autoRenumberMigrations: vi.fn(async () => ({ renumbered: false, renames: [] })),
    checkBranchTipIsAncestor: (() => {
      let calls = 0;
      return vi.fn(async () => {
        calls++;
        if (calls === 1) return { isAncestor: false as const, branchSha: "feature-sha", baseSha: "master-sha-before" };
        return { isAncestor: true as const, branchSha: "feature-sha", baseSha: "merge-commit-sha" };
      });
    })(),
    getUncommittedTrackedChanges: vi.fn(async () => []),
    countUniqueCommits: vi.fn(async () => 1),
    rebaseOntoBase: vi.fn(async () => ({ success: true })),
    mergeBaseIntoBranch: vi.fn(async () => ({ success: true })),
    ...overrides,
  };
}

async function seedApprovedWorkspace(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inReviewStatusId = randomUUID();
  const doneStatusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
    { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId, issueNumber: 821, title: "Gate path coverage", priority: "medium",
    sortOrder: 0, statusId: inReviewStatusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-821-test",
    workingDir: "/repo/.worktrees/feature_ak-821-test", baseBranch: "master",
    isDirect: false, status: "idle", readyForMerge: true, mergedAt: null,
    provider: "claude", createdAt: now, updatedAt: now,
  });

  return { projectId, issueId, workspaceId };
}

async function issueStatusName(db: ReturnType<typeof createTestDb>["db"], issueId: string): Promise<string> {
  const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
  const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
  return status.name;
}

describe("review-merge.gate.verify-smoke — gate decision + which merge path runs it (#821)", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  beforeEach(() => { ({ db } = createTestDb()); });

  it("the gate FAILS (withholds) the land when the project's verify_script exits non-zero, and PASSES it when it exits 0", async () => {
    const { projectId, workspaceId } = await seedApprovedWorkspace(db);
    await setPreference(verifyScriptPrefKey(projectId), ".\\verify.sh", db);

    // FAIL: a non-zero verify exit must withhold the merge.
    runSetupScript.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "compile error" });
    const failed = await runPreMergeGate({ id: workspaceId, workingDir: "/repo/.worktrees/feature_ak-821-test" }, projectId, db);
    expect(failed.passed).toBe(false);
    expect(failed.stage).toBe("verify");
    expect(failed.message).toContain("compile error");

    // PASS: a zero verify exit lets the land proceed.
    runSetupScript.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    const passed = await runPreMergeGate({ id: workspaceId, workingDir: "/repo/.worktrees/feature_ak-821-test" }, projectId, db);
    expect(passed.passed).toBe(true);
    expect(passed.skipped).toBe(false);
  });

  // #930 FIXED: the manual /merge path now runs the shared verify/smoke gate in `doMerge` before
  // landing, so a non-zero verify_script WITHHOLDS the land (thrown CONFLICT). This was an `it.fails`
  // known-gap marker; flipped to `it` now that the gate is wired into the operator merge body.
  it("manual /merge withholds the land when verify_script fails (#930)", async () => {
    const { projectId, workspaceId } = await seedApprovedWorkspace(db);
    await setPreference(verifyScriptPrefKey(projectId), ".\\verify.sh", db);
    runSetupScript.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "tests failed" });

    const git = makeGit();
    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    // Drive the real operator merge body. Tolerate either withhold shape (throw or merged:false).
    let merged: boolean | undefined;
    try {
      const result = await svc.mergeWorkspace(workspaceId);
      merged = result.merged;
    } catch {
      merged = false; // withheld via a thrown CONFLICT
    }

    // DESIRED behaviour: the manual path consulted the verify gate AND withheld the land.
    expect(runSetupScript).toHaveBeenCalled();
    expect(merged).toBe(false);
  });

  // #930 FIXED: the manual path now runs the gate even when it would PASS (exit 0) — the gate is
  // consulted before every operator merge (it does NOT skip on readyForMerge), and since it passes
  // here the branch lands. Flipped from `it.fails` to `it`.
  it("manual /merge runs the verify gate before landing even when it would PASS (#930)", async () => {
    const { projectId, issueId, workspaceId } = await seedApprovedWorkspace(db);
    await setPreference(verifyScriptPrefKey(projectId), ".\\verify.sh", db);
    runSetupScript.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });

    const git = makeGit();
    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    const result = await svc.mergeWorkspace(workspaceId);

    // DESIRED behaviour: the gate ran (verify consulted) and, since it passed, the branch landed.
    expect(runSetupScript).toHaveBeenCalled();
    expect(result.merged).toBe(true);
    expect(await issueStatusName(db, issueId)).toBe("Done");
  });

  // #943: the in-process monitor's auto-merge paths already run the gate against the same worktree
  // state in the same cycle (or rely on the review-exit gate for readyForMerge work). They pass
  // `skipPreMergeGate` so `doMerge` does NOT re-run it — otherwise an expensive build/boot doubles
  // per monitor merge. The skip is per-call, so the manual route (no flag) keeps gating.
  it("skipPreMergeGate suppresses the doMerge gate re-run, so the verify_script is NOT spawned again (#943)", async () => {
    const { projectId, issueId, workspaceId } = await seedApprovedWorkspace(db);
    await setPreference(verifyScriptPrefKey(projectId), ".\\verify.sh", db);
    runSetupScript.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });

    const git = makeGit();
    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    const result = await svc.mergeWorkspace(workspaceId, { skipPreMergeGate: true });

    // The gate did NOT run a second build, but the merge still landed.
    expect(runSetupScript).not.toHaveBeenCalled();
    expect(result.merged).toBe(true);
    expect(await issueStatusName(db, issueId)).toBe("Done");
  });

  // The monitor reaches doMerge via mergeWorkspaceDeduped — verify the skip flag threads through it too.
  it("mergeWorkspaceDeduped threads skipPreMergeGate through to doMerge (#943)", async () => {
    const { projectId, workspaceId } = await seedApprovedWorkspace(db);
    await setPreference(verifyScriptPrefKey(projectId), ".\\verify.sh", db);
    // Even a FAILING verify must not be consulted when the gate is skipped — it never runs.
    runSetupScript.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "would have failed" });

    const git = makeGit();
    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    const result = await svc.mergeWorkspaceDeduped(workspaceId, { skipPreMergeGate: true });

    expect(runSetupScript).not.toHaveBeenCalled();
    expect(result.merged).toBe(true);
  });
});
