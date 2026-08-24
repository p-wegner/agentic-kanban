/**
 * #239: `doMerge` must hand the pre-merge gate the workspace's `baseBranch`.
 *
 * It didn't — `resolveMergeGate` was called with `{ id, workingDir }` only, while `baseBranch`
 * sat in scope one line above. The consequences all follow from that one omission:
 *   - `resolveMergeGateShas` cannot resolve the base tip, so `baseSha` is `undefined`;
 *   - content-keyed `already-passed` evidence then matched on the branch tip alone, which ALSO
 *     waived the 15-minute freshness check (`evidenceIsValid` returns early on a match);
 *   - since the gate runs OUTSIDE the repo lock, workspace A can merge and move the base while
 *     B waits — and B's in-lock revalidation, unable to see the base, lands a merge RESULT that
 *     was never verified while carrying a token asserting it was. That is exactly the semantic
 *     migration `0108_merge_gate_shas.sql` claims to close.
 *   - the gate also loses the diff, so the docs-only skip and the test-package scoping die.
 *
 * The test asserts on the ARGUMENTS the merge path hands the gate, because that is the defect:
 * the base-moved rejection itself is pinned by `merge-gate-evidence-content-key.test.ts`, which
 * can inject `currentShas` directly instead of building a real repo and a 40-minute verify run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";

const tempRepos: string[] = [];
function makeRepoPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ak-gate-base-branch-repo-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  tempRepos.push(dir);
  return dir;
}

/** Every `resolveMergeGate` call, with the workspace shape and token it was given. */
interface GateCall {
  tokenKind: string;
  baseBranch: string | null | undefined;
  evidence?: { branchSha?: string; baseSha?: string };
}
const gateCalls: GateCall[] = [];

/** The fake repo's current tips, so the stub can model "base resolvable only via baseBranch". */
const repoTips = { branchSha: "branch-aaa", baseSha: "base-bbb" };

vi.mock("../services/pre-merge-gate.service.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // Faithful to the real implementation's decisive property: NO baseBranch means NO baseSha.
    resolveMergeGateShas: vi.fn(async (ws: { baseBranch?: string | null }) => ({
      branchSha: repoTips.branchSha,
      baseSha: ws.baseBranch ? repoTips.baseSha : undefined,
    })),
    resolveMergeGate: vi.fn(
      async ({
        token,
        workspace,
      }: {
        token: { kind: string; evidence?: { branchSha?: string; baseSha?: string } };
        workspace: { baseBranch?: string | null };
      }) => {
        gateCalls.push({ tokenKind: token.kind, baseBranch: workspace.baseBranch, evidence: token.evidence });
        if (token.kind === "already-passed") {
          return { passed: true, ran: false, stage: "verify", message: "proof accepted", decision: "already-passed" };
        }
        return { passed: true, ran: true, stage: "verify", message: "ok", decision: "run-gate" };
      },
    ),
  };
});

const { createWorkspaceMergeService } = await import("../services/workspace-merge.service.js");

function makeGit() {
  const merged = new Set<string>();
  const isMerged = (branch: string) => merged.has(branch);
  return {
    getDiff: vi.fn(async () => ""),
    getDiffFromRepo: vi.fn(async () => ""),
    revParse: vi.fn(async () => "some-sha"),
    isAncestor: vi.fn(async (_repo: string, branch: string) => isMerged(branch)),
    mergeBranch: vi.fn(async (_repo: string, branch: string) => {
      merged.add(branch);
      return "Merge made by the 'ort' strategy.";
    }),
    detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
    syncBranchToHead: vi.fn(async () => false),
    removeWorktree: vi.fn(async () => {}),
    deleteBranch: vi.fn(async () => {}),
    getChangedFilesBetween: vi.fn(async () => []),
    getCurrentBranch: vi.fn(async () => "master"),
    autoRenumberMigrations: vi.fn(async () => ({ renumbered: false, renames: [] })),
    checkBranchTipIsAncestor: vi.fn(async (_repo: string, branch: string) => ({
      isAncestor: isMerged(branch),
      branchSha: "feature-sha",
      baseSha: "master-sha",
    })),
    getUncommittedTrackedChanges: vi.fn(async () => []),
    countUniqueCommits: vi.fn(async () => 1),
    rebaseOntoBase: vi.fn(async () => ({ success: true })),
    mergeBaseIntoBranch: vi.fn(async () => ({ success: true })),
  };
}

async function seed(db: ReturnType<typeof createTestDb>["db"], repoPath: string, baseBranch: string) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inReviewStatusId = randomUUID();
  const doneStatusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Gate Base Branch Project",
    repoPath,
    repoName: "repo",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
    { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 239,
    title: "Gate base branch",
    priority: "medium",
    sortOrder: 0,
    statusId: inReviewStatusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-239-gate-base-branch",
    workingDir: `${repoPath}/.worktrees/ws0`,
    baseBranch,
    isDirect: false,
    status: "idle",
    readyForMerge: true,
    mergedAt: null,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });
  return { projectId, workspaceId };
}

describe("doMerge hands the pre-merge gate its baseBranch (#239)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
    gateCalls.length = 0;
  });

  afterEach(() => {
    while (tempRepos.length) {
      try { rmSync(tempRepos.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("passes baseBranch on EVERY gate consultation, so the base tip is assessable", async () => {
    const repoPath = makeRepoPath();
    const { workspaceId } = await seed(db, repoPath, "release/1.x");
    const svc = createWorkspaceMergeService({
      database: db,
      gitService: makeGit() as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.mergeWorkspace(workspaceId)).resolves.toBeDefined();

    // Pre-lock gate, then the in-lock re-resolve inside doMerge — the second is the #239 site.
    expect(gateCalls.map((c) => c.tokenKind)).toEqual(["run-gate", "already-passed"]);
    for (const call of gateCalls) {
      expect(call.baseBranch).toBe("release/1.x");
    }
  });

  it("mints evidence content-keyed to BOTH tips, not the branch alone", async () => {
    const repoPath = makeRepoPath();
    const { workspaceId } = await seed(db, repoPath, "master");
    const svc = createWorkspaceMergeService({
      database: db,
      gitService: makeGit() as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.mergeWorkspace(workspaceId)).resolves.toBeDefined();

    const proof = gateCalls.find((c) => c.tokenKind === "already-passed");
    expect(proof).toBeDefined();
    // A `baseSha` here is only possible because `baseBranch` reached `resolveMergeGateShas`.
    // Without it the evidence would be branch-only, which the content check now refuses to
    // treat as a match (and which used to waive the freshness check entirely).
    expect(proof!.evidence?.branchSha).toBe(repoTips.branchSha);
    expect(proof!.evidence?.baseSha).toBe(repoTips.baseSha);
  });

  it("uses the project defaultBranch as the gate's base when the workspace has none", async () => {
    // `requireBaseBranch(workspace.baseBranch || defaultBranch)` is what makes the value always
    // available — so there is never a reason for the gate call to omit it.
    const repoPath = makeRepoPath();
    const { workspaceId } = await seed(db, repoPath, null as unknown as string);
    const svc = createWorkspaceMergeService({
      database: db,
      gitService: makeGit() as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.mergeWorkspace(workspaceId)).resolves.toBeDefined();
    for (const call of gateCalls) {
      expect(call.baseBranch).toBe("master");
    }
  });
});
