// @covers review-merge.gate.verify-smoke [error-handling,config,risk]
//
// Behaviour (#821): a configured verify/smoke pre-merge gate must FAIL the merge when the project's
// verify_script exits non-zero (and must PASS the land when it exits 0). Test 1 pins that GATE
// DECISION directly.
//
// FINDING (confirmed by reading the call sites): `runPreMergeGate` is wired ONLY into the in-process
// monitor's auto-merge paths (monitor-cycle.ts:247 / :323) and the review-exit handler
// (exit-workflow.ts:536). The MANUAL/operator merge body — POST /api/workspaces/:id/merge →
// mergeWorkspace() → runWorkspacePreMergeValidation() — does NOT call runPreMergeGate. So a hand-merge
// (or the merge_queue orchestrator, which also goes through mergeWorkspace) can land build/test/boot-
// UNVERIFIED code even on a project that configured a verify gate. This is now filed as product
// ticket #930.
//
// SELF-FLIPPING MARKERS: the two manual-path tests below use `it.fails(...)`. Their bodies assert the
// DESIRED (post-#930-fix) behaviour — the gate runs and (on verify failure) the land is withheld.
// While the bug exists those assertions fail, so `it.fails` reports them as PASSING (suite green).
// When #930 is fixed and the manual path gates, the bodies pass → `it.fails` FAILS, forcing whoever
// lands the fix to flip these to `it(...)`. They are NOT change-detectors pinning the bug as correct.
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

  // `it.fails`: body asserts the DESIRED post-#930 behaviour (gate runs, land withheld on verify
  // failure). TODAY the manual path bypasses the gate, so the body FAILS → `it.fails` PASSES. When
  // #930 wires the gate into mergeWorkspace, the body PASSES → `it.fails` FAILS → flip this to `it`.
  it.fails("manual /merge SHOULD withhold the land when verify_script fails (open gap #930)", async () => {
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

  // `it.fails`: TODAY the manual path lands without ever consulting the gate, so `toHaveBeenCalled`
  // FAILS → `it.fails` PASSES. Post-#930 the manual path runs the gate (which passes here, exit 0) and
  // still lands → body PASSES → `it.fails` FAILS → flip to `it`.
  it.fails("manual /merge SHOULD run the verify gate before landing even when it would PASS (open gap #930)", async () => {
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
});
