import type { Database } from "../db/index.js";
import type { SessionManager } from "./session.manager.js";
import type { BoardEvents } from "./board-events.js";
import { createWorkspaceCrudService } from "./workspace-crud.service.js";
import { createWorkspaceDiffService } from "./workspace-diff.service.js";
import { createWorkspaceMergeService } from "./workspace-merge.service.js";
import { createWorkspaceSessionService } from "./workspace-session.service.js";
import { createWorkspaceCommentService } from "./workspace-comments.service.js";
import type { GitService } from "./workspace-internals.js";

export {
  WorkspaceError,
  type TurnResult,
  type CreateWorkspaceInput,
  type CreateWorkspaceResult,
  type GitService,
} from "./workspace-internals.js";

export function createWorkspaceService(deps: {
  database: Database;
  getSessionManager?: () => SessionManager;
  boardEvents?: BoardEvents;
  /** Injectable git service (defaults to the real module). Tests pass a fake. */
  gitService?: GitService;
  /** Injectable pre-merge backup hook (defaults to the real VACUUM-INTO backup). Tests pass a no-op. */
  createBackup?: (reason: string) => Promise<unknown>;
  /** Injectable process killer (defaults to the real killProcessesInDir). Tests pass a no-op. */
  processKiller?: (dir: string) => Promise<number>;
}) {
  const crud = createWorkspaceCrudService(deps);
  const diff = createWorkspaceDiffService(deps);
  const merge = createWorkspaceMergeService(deps);
  const session = createWorkspaceSessionService({
    database: deps.database,
    getSessionManager: deps.getSessionManager,
    boardEvents: deps.boardEvents,
    gitService: deps.gitService,
  });
  const comments = createWorkspaceCommentService(deps);

  return {
    // crud
    createWorkspace: crud.createWorkspace,
    deleteWorkspace: crud.deleteWorkspace,
    markReadyForMerge: crud.markReadyForMerge,
    setupWorkspace: crud.setupWorkspace,
    updateWorkspace: crud.updateWorkspace,
    getWorkspace: crud.getWorkspace,
    // diff
    getWorkspaceDiff: diff.getWorkspaceDiff,
    getConflicts: diff.getConflicts,
    getLatestCommit: diff.getLatestCommit,
    // merge
    mergeWorkspace: merge.mergeWorkspace,
    updateBase: merge.updateBase,
    abortRebase: merge.abortRebase,
    resolveConflicts: merge.resolveConflicts,
    fixAndMerge: merge.fixAndMerge,
    // session
    launchSession: session.launchSession,
    sendTurn: session.sendTurn,
    stopWorkspace: session.stopWorkspace,
    implementPlan: session.implementPlan,
    rejectPlan: session.rejectPlan,
    getPlanContent: session.getPlanContent,
    openTerminal: session.openTerminal,
    openEditor: session.openEditor,
    getSessions: session.getSessions,
    // comments
    listComments: comments.listComments,
    createComment: comments.createComment,
    updateComment: comments.updateComment,
    deleteComment: comments.deleteComment,
  };
}
