import { describe, it, expect, vi } from "vitest";

vi.mock("../repositories/workspace.repository.js", () => ({
  getWorkspaceById: vi.fn(async () => ({ id: "ws1", workingDir: "/wt", branch: "feature/ak-1", baseBranch: "master", status: "idle" })),
  resolveProjectRepo: vi.fn(async () => ({ defaultBranch: "master" })),
  resolveProjectId: vi.fn(async () => "p1"),
  updateWorkspaceStatus: vi.fn(async () => undefined),
}));
vi.mock("../repositories/workspace-ready-for-merge.repository.js", () => ({ stampWorkspaceReadyForMergeAt: vi.fn() }));
vi.mock("../services/workspace-base.js", () => ({ resolveWorkspaceBase: () => "master" }));
vi.mock("../services/phase-context.service.js", () => ({ buildConflictContext: vi.fn(async () => null) }));
vi.mock("../services/agent-settings.service.js", () => ({ toExecutorProvider: (p: string) => p }));
vi.mock("../services/workspace-internals.js", () => ({
  WorkspaceError: class extends Error {},
  resolveRelaunchAgentSelection: vi.fn(async () => ({ agentCommand: "claude", agentArgs: [], profile: null, provider: "claude", model: null })),
}));

import { createWorkspaceResolveConflictsService } from "../services/workspace-resolve-conflicts.service.js";
import { buildConflictResolutionPrompt } from "../services/merge-helpers.service.js";

describe("resolveConflicts under worker dispatch (#1776)", () => {
  it("pins the fix-conflicts session to the host that holds the in-progress rebase", async () => {
    const startSession = vi.fn(async () => "s1");
    const service = createWorkspaceResolveConflictsService({
      database: {} as never,
      gitService: {
        rebaseOntoBase: vi.fn(async () => ({ success: false, conflictingFiles: ["a.ts"] })),
        revParse: vi.fn(async () => "abc"),
      } as never,
      getSessionManager: () => ({ startSession }) as never,
      killWorktreeProcesses: async () => undefined,
      recoverZeroOutputRunningFixAndMergeSession: async () => undefined,
      recoverFailedFixAndMergeSessionIfNeeded: async () => undefined,
      recordMergeAttempt: async () => undefined,
    });
    await service.resolveConflicts("ws1");
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
      triggerType: "fix-conflicts",
      placement: { kind: "host" },
    }));
  });

  it("the prompt names the remote rebase path for an agent in a fresh clone", () => {
    const prompt = buildConflictResolutionPrompt(["a.ts"], "master");
    expect(prompt).toContain("git rebase origin/master");
    expect(prompt).toContain("push the rebased branch");
  });
});
