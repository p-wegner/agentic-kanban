import { describe, it, expect, vi, beforeEach } from "vitest";

// Wiring regression for the multi-repo crash-gap reconciler (#18): the function was
// exported from startup/merge-workflow.ts and fully tested, but never CALLED from the
// startup sequence — so the crash gap stayed open on every boot. This test locks the
// call into runStartupTasks (and its non-fatality) without touching any real process,
// git repo, or DB.

// ---- module mocks (everything runStartupTasks touches, heavy graphs stubbed) ----

/** Awaitable drizzle-ish query chain resolving to `rows` at every step. */
function makeQueryChain(rows: unknown[] = []): Record<string, unknown> {
  const resolved = Promise.resolve(rows);
  const chainObj: Record<string, unknown> = {};
  chainObj.then = resolved.then.bind(resolved);
  chainObj.catch = resolved.catch.bind(resolved);
  chainObj.from = () => chainObj;
  chainObj.where = () => chainObj;
  chainObj.limit = () => chainObj;
  chainObj.innerJoin = () => chainObj;
  return chainObj;
}

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(() => makeQueryChain([])),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(async () => {}),
        onConflictDoNothing: vi.fn(async () => {}),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => {}) })) })),
    delete: vi.fn(() => ({ where: vi.fn(async () => {}) })),
  },
  rawClient: {},
  rawWriteClient: {},
}));
vi.mock("node:child_process", () => ({
  // killOrphanedServers (win32): taskkill calls only, process listing goes through
  // ../services/process-exec.js (mocked below) so nothing is ever actually killed.
  execSync: vi.fn(() => ""),
}));
vi.mock("../services/process-exec.js", () => ({
  listOsProcesses: vi.fn(async () => []),
}));
vi.mock("../db/manual-migrate.js", () => ({ applyMigrations: vi.fn(async () => {}) }));
vi.mock("../db/backup.js", () => ({ createBackup: vi.fn(async () => {}) }));
vi.mock("../db/seed.js", () => ({ ensureBuiltinTags: vi.fn(async () => {}), ensureBuiltinSkills: vi.fn(async () => {}) }));
vi.mock("../db/builtin-workflows.js", () => ({ ensureBuiltinWorkflows: vi.fn(async () => {}) }));
vi.mock("../db/fk-violations.js", () => ({
  checkForeignKeyViolations: vi.fn(async () => []),
  logForeignKeyViolations: vi.fn(() => {}),
}));
vi.mock("../startup/fk-alignment.js", () => ({
  assertForeignKeysEnabled: vi.fn(async () => {}),
  alignForeignKeyActionsOnStartup: vi.fn(async () => {}),
}));
vi.mock("../services/project-registration.js", () => ({ deduplicateProjects: vi.fn(async () => {}) }));
vi.mock("../services/failure-pattern.service.js", () => ({ backfillFromLearnings: vi.fn(async () => 0) }));
vi.mock("../services/agent.service.js", () => ({}));
vi.mock("../services/git.service.js", () => ({
  isMergeInProgress: vi.fn(async () => false),
  abortMerge: vi.fn(async () => {}),
  isRebaseInProgress: vi.fn(async () => false),
  abortRebase: vi.fn(async () => {}),
  removeWorktree: vi.fn(async () => {}),
  deleteBranch: vi.fn(async () => {}),
  getCurrentBranch: vi.fn(async () => "master"),
}));
vi.mock("../services/workspace-repos.service.js", () => ({ cleanupSiblingWorktrees: vi.fn(async () => {}) }));
vi.mock("../services/merge-cleanup.service.js", () => ({
  finalizeMergeCleanup: vi.fn(async () => ({})),
  reconcileMergedIssue: vi.fn(async () => ({})),
}));
vi.mock("../repositories/board-health-events.repository.js", () => ({ logBoardHealthEvent: vi.fn(async () => "event-id") }));
vi.mock("../repositories/workspace-status.repository.js", () => ({ setWorkspaceStatus: vi.fn(async () => {}) }));
vi.mock("../services/effective-config.service.js", () => ({ MODEL_PREF_KEYS_BY_PROVIDER: {} }));
vi.mock("../services/agent-provider.js", () => ({ narrowProviderName: vi.fn(() => "claude") }));
vi.mock("../startup/ancestor-branch-reconciler.js", () => ({ reconcileAncestorBranchWorkspaces: vi.fn(async () => {}) }));
vi.mock("../startup/done-unmerged-invariant-scanner.js", () => ({ scanDoneUnmergedWorkspaces: vi.fn(async () => {}) }));
vi.mock("../startup/terminal-workspace-reaper.js", () => ({ reapTerminalWorkspaces: vi.fn(async () => {}) }));
// The target: the stranded-sibling reconciler is dynamically imported by runStartupTasks.
vi.mock("../startup/merge-workflow.js", () => ({
  reconcileStrandedSiblingMerges: vi.fn(async () => ({ landed: 0, preserved: 0 })),
}));

import { runStartupTasks } from "../startup/startup-tasks.js";
import { reconcileStrandedSiblingMerges } from "../startup/merge-workflow.js";
import { reapTerminalWorkspaces } from "../startup/terminal-workspace-reaper.js";

const sessionManager = {} as unknown as Parameters<typeof runStartupTasks>[0];

describe("runStartupTasks wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes reconcileStrandedSiblingMerges during the startup sequence", async () => {
    await runStartupTasks(sessionManager);
    expect(vi.mocked(reconcileStrandedSiblingMerges)).toHaveBeenCalledTimes(1);
  });

  it("treats a reconciler failure as non-fatal — later startup tasks still run", async () => {
    vi.mocked(reconcileStrandedSiblingMerges).mockRejectedValueOnce(new Error("boom"));
    await expect(runStartupTasks(sessionManager)).resolves.toBeUndefined();
    expect(vi.mocked(reapTerminalWorkspaces)).toHaveBeenCalledTimes(1);
  });
});
