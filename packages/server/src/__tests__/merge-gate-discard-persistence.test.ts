/**
 * #1030: a DISCARDED gate verdict must be persisted, not just logged.
 *
 * Measured on #1017: `noteMergeGateAttemptStarted/Finished` keep the attempt list on an
 * in-memory job, `workspace_merge_gate` only ever holds evidence for a token that WAS minted,
 * and the discard `console.warn` lands in a dev log that is truncated on every `pnpm dev`. So
 * "should #243's discard be relaxed?" could only be argued by reconstructing base movement from
 * `git log` committer dates. `runGateWithEvidence` now appends one `merge_gate_discards` row per
 * discarded verdict — sha pair per tip, the base move's file list, the run's impact selection,
 * source/stage/duration/attempt — and this pins that it does, that it is INSTRUMENTATION ONLY
 * (the verdict is still discarded, the token still null), and that a failed write never fails
 * the protocol.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/index.js";
import type { MergeGateShas, PreMergeGateWorkspace } from "../services/pre-merge-gate.service.js";
import { runGateWithEvidence } from "../services/merge-gate-evidence.js";
import { getMergeJob, resetMergeJobs, startMergeJob } from "../services/merge-job.service.js";
import { listMergeGateDiscards } from "../repositories/merge-gate-discard.repository.js";
import { projects, projectStatuses, issues, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";

const T0 = "2026-09-04T00:00:00.000Z";

async function seedWorkspace(db: ReturnType<typeof createTestDb>["db"]): Promise<string> {
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: T0, updatedAt: T0,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: T0,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 1, title: "Issue 1", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: T0, updatedAt: T0,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-1", workingDir: "/repo/.worktrees/ws",
    baseBranch: "master", status: "idle", provider: "claude", createdAt: T0, updatedAt: T0,
  });
  return workspaceId;
}

const IMPACT_SELECTION = { selectedCount: 6, belowFloorCount: 37, stale: false, selectionTier: "impact", changedCount: 3 };

async function runProtocol(args: {
  database: Database;
  workspaceId: string;
  shas: [MergeGateShas, MergeGateShas];
  baseMoveFiles?: string[] | null;
  impactSelection?: typeof IMPACT_SELECTION | null;
  readBaseMoveFiles?: (workingDir: string, before: string, after: string) => Promise<string[] | null>;
}) {
  let reads = 0;
  const workspace: PreMergeGateWorkspace = { id: args.workspaceId, workingDir: "/repo/.worktrees/ws", baseBranch: "master" };
  return runGateWithEvidence({
    workspace,
    projectId: "project-1",
    source: "pre-lock-merge",
    database: args.database,
    readShas: async () => args.shas[Math.min(reads++, 1)],
    runGate: async () => ({
      passed: true,
      ran: true,
      stage: "verify" as const,
      message: "pre-merge gate passed (tier: impact-scoped, 6 suites)",
      ...(args.impactSelection !== undefined ? { impactSelection: args.impactSelection } : {}),
    }),
    readBaseMoveFiles: args.readBaseMoveFiles ?? (async () => args.baseMoveFiles ?? null),
  });
}

describe("runGateWithEvidence persists a discarded verdict (#1030)", () => {
  beforeEach(() => resetMergeJobs());

  it("records a BASE move with the sha pair, the base move's file list and the impact selection", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    const job = startMergeJob(workspaceId);
    const seen: string[] = [];

    const result = await runProtocol({
      database: db,
      workspaceId,
      shas: [{ branchSha: "branch-1", baseSha: "base-1" }, { branchSha: "branch-1", baseSha: "base-2" }],
      impactSelection: IMPACT_SELECTION,
      readBaseMoveFiles: async (workingDir, before, after) => {
        seen.push(`${workingDir} ${before}..${after}`);
        return ["docs/tests/impact-map.json", "packages/server/src/x.ts"];
      },
    });

    // Instrumentation only: the discard itself is unchanged.
    expect(result.moved).toBe("base");
    expect(result.token).toBeNull();
    expect(getMergeJob(workspaceId)!.attempts[0].outcome).toBe("discarded");

    // The diff is taken in the worktree, old base -> new base.
    expect(seen).toEqual(["/repo/.worktrees/ws base-1..base-2"]);

    const rows = await listMergeGateDiscards(workspaceId, db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId,
      source: "pre-lock-merge",
      stage: "verify",
      moved: "base",
      jobId: job.jobId,
      attempt: 1,
      branchShaBefore: "branch-1",
      branchShaAfter: "branch-1",
      baseShaBefore: "base-1",
      baseShaAfter: "base-2",
    });
    expect(rows[0].discardedAt).toBe(result.ranAt);
    expect(rows[0].durationMs).toBe(result.durationMs);
    expect(JSON.parse(rows[0].baseMoveFiles!)).toEqual(["docs/tests/impact-map.json", "packages/server/src/x.ts"]);
    expect(JSON.parse(rows[0].impactSelection!)).toEqual(IMPACT_SELECTION);
  });

  it("records a BRANCH move with no base-move file list and no job when the gate ran outside one", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    let diffed = 0;

    const result = await runProtocol({
      database: db,
      workspaceId,
      shas: [{ branchSha: "verified", baseSha: "base-1" }, { branchSha: "builder-committed", baseSha: "base-1" }],
      readBaseMoveFiles: async () => { diffed++; return ["never"]; },
    });

    expect(result.moved).toBe("branch");
    expect(diffed).toBe(0); // the base did not move, so there is no base diff to take
    const [row] = await listMergeGateDiscards(workspaceId, db);
    expect(row).toMatchObject({
      moved: "branch",
      branchShaBefore: "verified",
      branchShaAfter: "builder-committed",
      baseShaBefore: "base-1",
      baseShaAfter: "base-1",
      baseMoveFiles: null,
      impactSelection: null, // the run was not made under the impact selector
      jobId: null,
      attempt: null,
    });
  });

  it("records nothing for a pass whose tips held still, or for a failed gate", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    await runProtocol({ database: db, workspaceId, shas: [{ branchSha: "a", baseSha: "b" }, { branchSha: "a", baseSha: "b" }] });
    expect(await listMergeGateDiscards(workspaceId, db)).toEqual([]);

    await runGateWithEvidence({
      workspace: { id: workspaceId, workingDir: "/repo/.worktrees/ws", baseBranch: "master" },
      projectId: "project-1",
      source: "pre-lock-merge",
      database: db,
      readShas: async () => ({ branchSha: "a", baseSha: "b" }),
      runGate: async () => ({ passed: false, ran: true, stage: "verify" as const, message: "red" }),
    });
    expect(await listMergeGateDiscards(workspaceId, db)).toEqual([]);
  });

  it("an unreadable base diff records the discard with a null file list rather than dropping it", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    await runProtocol({
      database: db,
      workspaceId,
      shas: [{ branchSha: "a", baseSha: "base-1" }, { branchSha: "a", baseSha: "base-2" }],
      readBaseMoveFiles: async () => { throw new Error("git exploded"); },
    });
    const [row] = await listMergeGateDiscards(workspaceId, db);
    expect(row).toMatchObject({ moved: "base", baseShaBefore: "base-1", baseShaAfter: "base-2", baseMoveFiles: null });
  });

  it("a failed write never fails the protocol — the discard verdict still stands", async () => {
    const result = await runProtocol({
      database: {} as Database, // no `insert` — the write throws and is swallowed
      workspaceId: "ws-no-db",
      shas: [{ branchSha: "a", baseSha: "base-1" }, { branchSha: "a", baseSha: "base-2" }],
    });
    expect(result.moved).toBe("base");
    expect(result.token).toBeNull();
  });

  it("lists a workspace's discards newest first", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    await runProtocol({ database: db, workspaceId, shas: [{ branchSha: "a", baseSha: "b1" }, { branchSha: "a", baseSha: "b2" }] });
    await new Promise((r) => setTimeout(r, 5));
    await runProtocol({ database: db, workspaceId, shas: [{ branchSha: "a", baseSha: "b2" }, { branchSha: "a", baseSha: "b3" }] });
    const rows = await listMergeGateDiscards(workspaceId, db);
    expect(rows.map((r) => r.baseShaAfter)).toEqual(["b3", "b2"]);
  });
});
