import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, preferences, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createAutoMergeOrchestrator } from "../startup/auto-merge-orchestrator.js";
import { reconcileCompletionStates } from "../startup/completion-state-reconciler.js";
import { reconcileDriveCompletion } from "../startup/drive-completion-reconciler.js";
import { reconcileProjectCompletion } from "../startup/project-completion-reconciler.js";

// The three drift-healing passes are the observable under test — mock them so a
// call is countable and no real reconciliation work runs.
vi.mock("../startup/completion-state-reconciler.js", () => ({
  reconcileCompletionStates: vi.fn(async () => 0),
}));
vi.mock("../startup/drive-completion-reconciler.js", () => ({
  reconcileDriveCompletion: vi.fn(async () => 0),
}));
vi.mock("../startup/project-completion-reconciler.js", () => ({
  reconcileProjectCompletion: vi.fn(async () => 0),
}));

async function seedEnabledPrefs(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  await db.insert(preferences).values([
    { key: "auto_merge", value: "true", updatedAt: now },
    { key: "auto_monitor", value: "true", updatedAt: now },
    { key: "merge_strategy", value: "merge_queue", updatedAt: now },
  ]);
}

async function seedCandidate(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "P",
    repoPath: "/tmp/repo",
    repoName: "repo",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({
    id: statusId,
    projectId,
    name: "AI Reviewed",
    sortOrder: 0,
    isDefault: false,
    createdAt: now,
  });
  const issueId = randomUUID();
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 1,
    title: "Issue",
    priority: "medium",
    sortOrder: 0,
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: randomUUID(),
    issueId,
    branch: "feature/gate-test",
    workingDir: "/tmp/repo/.worktrees/gate-test",
    baseBranch: "main",
    isDirect: false,
    status: "idle",
    readyForMerge: true,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });
}

function reconcileCallCounts() {
  return [
    vi.mocked(reconcileCompletionStates).mock.calls.length,
    vi.mocked(reconcileDriveCompletion).mock.calls.length,
    vi.mocked(reconcileProjectCompletion).mock.calls.length,
  ];
}

describe("auto-merge orchestrator reconcile gating (#402)", () => {
  it("skips the three reconcile passes on zero-candidate ticks, except on the slow fallback interval", async () => {
    vi.clearAllMocks();
    const { db } = createTestDb();
    await seedEnabledPrefs(db);

    const orchestrator = createAutoMergeOrchestrator({
      database: db,
      reconcileFallbackEveryTicks: 3,
    });

    await orchestrator.runOnce(); // tick 1 — fallback (startup heal) → passes run
    expect(reconcileCallCounts()).toEqual([1, 1, 1]);

    await orchestrator.runOnce(); // tick 2 — zero candidates, not fallback → skipped
    await orchestrator.runOnce(); // tick 3 — zero candidates, not fallback → skipped
    expect(reconcileCallCounts()).toEqual([1, 1, 1]);

    await orchestrator.runOnce(); // tick 4 — fallback again (4 % 3 === 1) → passes run
    expect(reconcileCallCounts()).toEqual([2, 2, 2]);
  });

  it("runs the reconcile passes on a non-fallback tick when merge candidates exist", async () => {
    vi.clearAllMocks();
    const { db } = createTestDb();
    await seedEnabledPrefs(db);

    const orchestrator = createAutoMergeOrchestrator({
      database: db,
      reconcileFallbackEveryTicks: 1_000,
    });

    await orchestrator.runOnce(); // tick 1 — always fallback → 1 call each
    expect(reconcileCallCounts()).toEqual([1, 1, 1]);

    await seedCandidate(db);

    // tick 2 — NOT a fallback tick, but a candidate exists → passes must run.
    // (The subsequent merge attempt fails against the fake repo path; the
    // orchestrator's own try/catch swallows that — gating is what's under test.)
    await orchestrator.runOnce();
    expect(reconcileCallCounts()).toEqual([2, 2, 2]);
  });
});
