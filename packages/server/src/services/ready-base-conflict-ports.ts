/**
 * The real ports for the ready-workspace base-conflict healer (#1584): the board's own
 * update-base action, session turn/launch, and read-only git probes. Kept apart from
 * `startup/ready-base-conflict-healer.ts` so that file stays a pure, injectable sweep.
 */
import type { Database } from "../db/index.js";
import type { BoardEventSink } from "./board-events.js";
import type { SessionManager } from "./session.manager.js";
import { createWorkspaceMergeService } from "./workspace-merge.service.js";
import { createWorkspaceSessionService } from "./workspace-session.service.js";
import { resolveWorkspaceBase } from "./workspace-base.js";
import { getMergeJob } from "./merge-job.service.js";
import { findLiveMergeTrainForProject, snapshotLiveMergeTrains } from "./merge-train-live-registry.js";
import { rebaseKeepingBoth } from "./base-conflict-keep-both.js";
import { getMergeHold } from "../repositories/merge-hold.repository.js";
import { findRunningSession } from "../repositories/session.repository.js";
import { resolveProjectRepo, getWorkspaceById } from "../repositories/workspace.repository.js";
import { listReadyHealCandidates } from "../repositories/merge-queue.repository.js";
import { detectConflictsByBranch, revParse } from "@agentic-kanban/shared/lib/git-service";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import type { ReadyBaseConflictHealDeps } from "../startup/ready-base-conflict-healer.js";

const MAX_BASE_COMMITS = 8;

export function createReadyBaseConflictHealDeps(args: {
  database: Database;
  boardEvents?: BoardEventSink;
  getSessionManager: () => SessionManager;
}): ReadyBaseConflictHealDeps {
  const { database, boardEvents, getSessionManager } = args;
  const mergeService = createWorkspaceMergeService({ database, boardEvents, getSessionManager });
  const sessionService = createWorkspaceSessionService({ database, boardEvents, getSessionManager });
  return {
    database,
    listCandidates: () => listReadyHealCandidates(database),
    resolveRepo: async (c) => {
      const workspace = await getWorkspaceById(c.workspaceId, database);
      if (!workspace) return null;
      const { repoPath, defaultBranch } = await resolveProjectRepo(c.workspaceId, database);
      return { repoPath, baseBranch: resolveWorkspaceBase(workspace, { defaultBranch }) };
    },
    // A live train for the project owns branch tips for the window; a merge job gates this worktree.
    isBusy: async (c) =>
      Boolean(await getMergeHold(c.workspaceId, database))
      || getMergeJob(c.workspaceId)?.state === "running"
      || Boolean(findLiveMergeTrainForProject(snapshotLiveMergeTrains(), c.projectId))
      || Boolean(await findRunningSession(c.workspaceId, database)),
    detectConflicts: async (repoPath, branch, baseBranch) => {
      const r = await detectConflictsByBranch(repoPath, branch, baseBranch);
      return { hasConflicts: r.hasConflicts, files: r.conflictingFiles };
    },
    rebase: (workspaceId) => mergeService.updateBase(workspaceId, "rebase"),
    rebaseKeepBoth: rebaseKeepingBoth,
    baseCommitsTouching: async (repoPath, branch, baseBranch, files) => {
      const res = await gitExec(
        ["log", "--format=%h %s", `-n${MAX_BASE_COMMITS}`, `${branch}..${baseBranch}`, "--", ...files],
        { cwd: repoPath },
      );
      return res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    },
    branchTip: async (repoPath, branch) => (await revParse(repoPath, branch).catch(() => "")).trim() || null,
    hasLiveSession: async (workspaceId) => Boolean(await findRunningSession(workspaceId, database)),
    sendTurn: (workspaceId, content) => sessionService.sendTurn(workspaceId, content, { fromTrain: true }),
    relaunch: (workspaceId, prompt) => sessionService.launchSession(workspaceId, { prompt, fromTrain: true }),
  };
}
