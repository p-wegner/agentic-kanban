import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The post-merge FOLLOW-UP auto-start used to be gated on the global `auto_start_followup`
 * pref ALONE, so a project whose Start Mode is `manual` — the switch documented as a true
 * kill-switch (decision 008) — still had agents launched for it every time one of its
 * tickets merged. The sibling dependency cascade was already gated on the resolved policy
 * (`dependency-auto-chain.service.ts`); this locks the same gate on the follow-up path.
 */

// Never touch the real DB: this module's import graph reaches repositories that open a
// client at module top level (see #231).
vi.mock("../db/index.js", () => ({ db: {} }));

vi.mock("../services/followup-workspace.service.js", () => ({
  autoStartFollowups: vi.fn(async () => {}),
}));
vi.mock("../services/dependency-auto-chain.service.js", () => ({
  autoStartUnblockedDependencyIssue: vi.fn(async () => {}),
}));
vi.mock("../services/merge-executor.service.js", () => ({
  cleanupMergedWorktreeAndBranch: vi.fn(async () => {}),
}));
vi.mock("../services/workspace-repos.service.js", () => ({
  cleanupSiblingWorktrees: vi.fn(async () => {}),
}));
vi.mock("../services/merge-helpers.service.js", () => ({
  rebuildSharedIfChanged: vi.fn(async () => {}),
  runLearningStep: vi.fn(async () => {}),
}));

import { runWorkspacePostMergeCleanup } from "../services/workspace-merge-cleanup.service.js";
import { autoStartFollowups } from "../services/followup-workspace.service.js";
import type { SessionManager } from "../services/session.manager.js";
import type { GitService } from "../services/workspace-internals.js";
import { startModePrefKey } from "../services/start-policy.service.js";

const PROJECT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** A direct workspace with no preMergeHead, so every cleanup step before the gate no-ops. */
function cleanupArgs(prefMap: Map<string, string>) {
  return {
    workspaceId: "ws-1",
    issueId: "issue-1",
    repoPath: "/repo",
    preMergeHead: "",
    prefMap,
    projectId: PROJECT_ID,
    workingDir: null,
    branch: "feature/ak-1-test",
    mergeResult: "merged",
    teardownScript: null,
    setupEnabled: false,
    isDirect: true,
  };
}

const deps = {
  database: {} as never,
  gitService: {
    getChangedFilesBetween: async () => [],
  } as unknown as GitService,
  killProcesses: async () => 0,
  getSessionManager: () => ({}) as SessionManager,
};

async function runWith(prefs: Record<string, string>) {
  await runWorkspacePostMergeCleanup(cleanupArgs(new Map(Object.entries(prefs))), deps);
}

describe("post-merge follow-up auto-start honours Start Mode", () => {
  beforeEach(() => {
    vi.mocked(autoStartFollowups).mockClear();
  });

  it("does NOT auto-start follow-ups when the project's Start Mode is manual", async () => {
    await runWith({ auto_start_followup: "true", [startModePrefKey(PROJECT_ID)]: "manual" });
    expect(vi.mocked(autoStartFollowups)).not.toHaveBeenCalled();
  });

  it("does NOT auto-start follow-ups for a conductor project (the external loop drives it)", async () => {
    await runWith({ auto_start_followup: "true", [startModePrefKey(PROJECT_ID)]: "conductor" });
    expect(vi.mocked(autoStartFollowups)).not.toHaveBeenCalled();
  });

  it("DOES auto-start follow-ups in monitor mode with the pref on", async () => {
    await runWith({ auto_start_followup: "true", [startModePrefKey(PROJECT_ID)]: "monitor" });
    expect(vi.mocked(autoStartFollowups)).toHaveBeenCalledTimes(1);
  });

  it("still respects the auto_start_followup pref itself in monitor mode", async () => {
    await runWith({ [startModePrefKey(PROJECT_ID)]: "monitor" });
    expect(vi.mocked(autoStartFollowups)).not.toHaveBeenCalled();
  });

  it("keeps working for a legacy autodrive project with no explicit start_mode", async () => {
    await runWith({ auto_start_followup: "true", [`board_autodrive_${PROJECT_ID}`]: "true" });
    expect(vi.mocked(autoStartFollowups)).toHaveBeenCalledTimes(1);
  });
});
