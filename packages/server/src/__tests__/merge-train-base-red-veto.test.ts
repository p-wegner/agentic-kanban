import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { baseBranchHealth, issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createAutoMergeOrchestrator } from "../startup/auto-merge-orchestrator.js";
import { decideBaseRedVeto, resolveBaseRedVeto } from "../services/merge-train-base-veto.js";
import { runMergeTrain } from "../services/merge-train.service.js";

/**
 * #1204 — a merge train must not depart on a RED base, and a red full train must ask ONE
 * question about the bare base before it starts blaming members.
 *
 * MEASURED motivation: on a red master the window still released a 14-member train.
 * train/2026-09-19-02 spent 27 gate runs bisecting the base's own failures, marked all 14
 * members `gateRejected`, and landed nothing.
 */

// ── half 1: the pure veto decision ──────────────────────────────────────────────────────

const block = { redBasePolicy: "block" } as const;

describe("decideBaseRedVeto (#1204)", () => {
  it("vetoes a red base the tip has not moved past", () => {
    expect(decideBaseRedVeto({ outcome: "red", healthSha: "abc", baseAheadOfHealthSha: false, ...block }, "4 suites failed"))
      .toEqual({ healthSha: "abc", message: "4 suites failed" });
  });

  it("does NOT veto once the base has moved past the red sha — the commits since may be the fix", () => {
    expect(decideBaseRedVeto({ outcome: "red", healthSha: "abc", baseAheadOfHealthSha: true, ...block })).toBeNull();
  });

  it("does not veto on green, nor on a NON-ANSWER probe (a false red would withhold every merge)", () => {
    expect(decideBaseRedVeto({ outcome: "green", healthSha: "abc", baseAheadOfHealthSha: false, ...block })).toBeNull();
    expect(decideBaseRedVeto({ outcome: "timeout", healthSha: "abc", baseAheadOfHealthSha: false, ...block })).toBeNull();
    expect(decideBaseRedVeto({ outcome: "unverified", healthSha: "abc", baseAheadOfHealthSha: false, ...block })).toBeNull();
    expect(decideBaseRedVeto({ outcome: null, healthSha: null, baseAheadOfHealthSha: false, ...block })).toBeNull();
  });

  it("holds ONLY under a `block` red-base policy — every softer policy reports instead (#1233)", () => {
    for (const redBasePolicy of ["allow-known-debt", "allow-file-debt-ticket", "report"] as const) {
      expect(decideBaseRedVeto({ outcome: "red", healthSha: "abc", baseAheadOfHealthSha: false, redBasePolicy }, "red"))
        .toBeNull();
    }
  });
});

// ── half 2: the window holds instead of releasing ───────────────────────────────────────

async function seedProject(db: ReturnType<typeof createTestDb>["db"], repoPath: string) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "P", repoPath, repoName: "repo", defaultBranch: "main",
    createdAt: now, updatedAt: now,
  });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "AI Reviewed", sortOrder: 0, isDefault: false, createdAt: now,
  });
  return { projectId, statusId };
}

let issueNumber = 1;
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

describe("the train departure window holds on a red base (#1204)", () => {
  it("holds with verdict base_red instead of releasing, and keeps accumulating", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db, "/tmp/repo");
    await seedReady(db, projectId, statusId);
    await seedReady(db, projectId, statusId);
    await seedReady(db, projectId, statusId);
    await seedReady(db, projectId, statusId);

    const orchestrator = createAutoMergeOrchestrator({
      database: db,
      checkBaseRedVeto: async () => ({ healthSha: "deadbeefcafe", message: "4 guard suites failed" }),
    });
    const rows = await orchestrator.findCompletedWorkspaceRows();
    // Four ready workspaces reach the default max size, so the window WOULD release.
    const released = await orchestrator.applyTrainWindow(rows, new Date().toISOString());

    expect(released).toEqual([]);
    const window = orchestrator.state.trainWindows.get(projectId);
    expect(window?.lastVerdict).toEqual({ release: false, reason: "base_red" });
    expect(window?.pendingIds).toHaveLength(4);
  });

  it("releases normally when the base is not red", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db, "/tmp/repo");
    for (let i = 0; i < 4; i++) await seedReady(db, projectId, statusId);

    const orchestrator = createAutoMergeOrchestrator({ database: db, checkBaseRedVeto: async () => null });
    const rows = await orchestrator.findCompletedWorkspaceRows();
    const released = await orchestrator.applyTrainWindow(rows, new Date().toISOString());

    expect(released).toHaveLength(4);
    expect(orchestrator.state.trainWindows.get(projectId)).toBeUndefined();
  });

  it("resolveBaseRedVeto reads the project's latest row and vetoes on an unresolvable repo", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db, join(tmpdir(), "kanban-no-such-repo"));
    await db.insert(baseBranchHealth).values({
      id: randomUUID(), projectId, sha: "0".repeat(40), branch: "main", outcome: "red",
      message: "verify failed", createdAt: new Date().toISOString(),
    });
    // The tip cannot be read, so the base is not known to have moved past the red sha — a red
    // measurement is evidence and an unanswerable git question is not a reason to discard it.
    await expect(resolveBaseRedVeto(projectId, db)).resolves.toMatchObject({ healthSha: "0".repeat(40) });
  });
});

// ── half 3: the control arm ─────────────────────────────────────────────────────────────

let repo: string;
const git = (args: string[]) => gitExecOrThrow(args, { cwd: repo });

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "kanban-train-basearm-"));
  await git(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
  await git(["add", "."]);
  await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "chore: base"]);
  for (const [branch, file] of [["f1", "a.txt"], ["f2", "b.txt"], ["f3", "c.txt"], ["f4", "d.txt"]]) {
    await git(["checkout", "-q", "-b", branch, "main"]);
    writeFileSync(join(repo, file), file, "utf8");
    await git(["add", file]);
    await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `feat: ${file}`]);
  }
  await git(["checkout", "-q", "main"]);
});

afterEach(() => {
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
});

const fourMembers = [
  { workspaceId: "w1", branch: "f1", issueNumber: 1 },
  { workspaceId: "w2", branch: "f2", issueNumber: 2 },
  { workspaceId: "w3", branch: "f3", issueNumber: 3 },
  { workspaceId: "w4", branch: "f4", issueNumber: 4 },
];

describe("runMergeTrain's control arm (#1204)", () => {
  it("a red base stops the bisect dead: ONE extra gate run, zero gateRejected, every member still aboard", async () => {
    const runGate = vi.fn().mockResolvedValue({ passed: false, message: "4 guard suites failed" });
    const closeMember = vi.fn().mockResolvedValue(undefined);
    const gateBaseAlone = vi.fn().mockResolvedValue({ verdict: "red" as const, gateRuns: 1 });

    const result = await runMergeTrain({
      repoPath: repo, baseBranch: "main", members: fourMembers, label: "b1",
      runGate, closeMember, gateBaseAlone,
    });

    // The whole saving: the top-level attempt plus the control arm, and NO halving.
    expect(runGate).toHaveBeenCalledTimes(1);
    expect(gateBaseAlone).toHaveBeenCalledTimes(1);
    expect(result.gateRuns).toBe(2);
    expect(result.baseVerdict).toBe("red");
    expect(result.gateRejected).toEqual([]);
    expect(result.landed).toEqual([]);
    expect(result.gateFailure).toContain("4 guard suites failed");
  });

  it("a green base lets the bisect proceed and records the verdict", async () => {
    // Red for the full batch, green for either half — the classic "two members collide" shape.
    const runGate = vi.fn(async ({ included }: { included: Array<{ workspaceId: string }> }) =>
      included.length > 2 ? { passed: false, message: "red" } : { passed: true, message: "ok" });
    const closeMember = vi.fn().mockResolvedValue(undefined);
    const gateBaseAlone = vi.fn().mockResolvedValue({ verdict: "green" as const, gateRuns: 1 });

    const result = await runMergeTrain({
      repoPath: repo, baseBranch: "main", members: fourMembers, label: "b2",
      runGate, closeMember, gateBaseAlone, freeVerifySlots: () => 0,
    });

    expect(gateBaseAlone).toHaveBeenCalledTimes(1);
    expect(result.baseVerdict).toBe("green");
    expect(result.landed.map((m) => m.workspaceId)).toEqual(["w1", "w2", "w3", "w4"]);
    // 1 (full, red) + 1 (control arm) + 2 (the two green halves).
    expect(result.gateRuns).toBe(4);
  });

  it("is never asked on a green train, nor for a singleton that cannot be bisected", async () => {
    const gateBaseAlone = vi.fn();
    const closeMember = vi.fn().mockResolvedValue(undefined);

    await runMergeTrain({
      repoPath: repo, baseBranch: "main", members: fourMembers, label: "b3",
      runGate: vi.fn().mockResolvedValue({ passed: true, message: "ok" }), closeMember, gateBaseAlone,
    });
    expect(gateBaseAlone).not.toHaveBeenCalled();

    await runMergeTrain({
      repoPath: repo, baseBranch: "main", members: [fourMembers[0]], label: "b4",
      runGate: vi.fn().mockResolvedValue({ passed: false, message: "red" }), closeMember, gateBaseAlone,
    });
    expect(gateBaseAlone).not.toHaveBeenCalled();
  });

  it("a control arm that cannot answer leaves the bisect exactly as it was before #1204", async () => {
    const runGate = vi.fn().mockResolvedValue({ passed: false, message: "red everywhere" });
    const closeMember = vi.fn().mockResolvedValue(undefined);

    const result = await runMergeTrain({
      repoPath: repo, baseBranch: "main", members: fourMembers, label: "b5",
      runGate, closeMember, gateBaseAlone: async () => null, freeVerifySlots: () => 0,
    });

    expect(result.baseVerdict).toBeUndefined();
    // Every member bisected down to a red singleton, as it always did.
    expect(result.gateRejected.map((r) => r.member.workspaceId).sort()).toEqual(["w1", "w2", "w3", "w4"]);
  });
});
