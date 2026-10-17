// #1582: a remote session whose result never reached the board (no incoming ref — e.g. lost
// around a promote restart) and whose branch holds no commits beyond the base has produced
// nothing to review. Leaving the issue In Progress/In Review points it at a dead workspace that
// the monitor will never restart; send it back to Todo with a logged reason instead.
import { transitionIssueStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { issues } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import type { Database } from "../../db/index.js";
import { closeWorkspace } from "../../services/workspace-lifecycle-reconcile.service.js";

/** The marker `landSessionBranch` (agent-remote-finalize.ts) writes to the transcript. */
const NOT_LANDED_MARKER = /Worker result could not be landed on .*no incoming ref/i;

/** Pure: does this session transcript say the worker's result never arrived? */
export function isLostRemoteResult(stderr: string): boolean {
  return NOT_LANDED_MARKER.test(stderr);
}

export interface LostRemoteResultInput {
  database: Database;
  workspaceId: string;
  issueId: string;
  sessionId: string;
  stderr: string;
  /** Commits on the branch beyond the base; null when unknown (worktree gone) counts as none. */
  commitsAhead: number | null;
  statuses: { id: string; name: string }[];
  now: string;
}

/** Returns true when the issue was sent back to Todo (workspace closed, slot freed). */
export async function requeueLostRemoteResult(input: LostRemoteResultInput): Promise<boolean> {
  const { database, workspaceId, issueId, sessionId, stderr, commitsAhead, statuses, now } = input;
  if (!isLostRemoteResult(stderr)) return false;
  if (commitsAhead !== null && commitsAhead > 0) return false;
  const todo = statuses.find((s) => s.name === "Todo");
  if (!todo) return false;
  const rows = await database.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId)).limit(1);
  const current = statuses.find((s) => s.id === rows[0]?.statusId)?.name;
  if (current !== "In Progress" && current !== "In Review") return false;
  console.warn(`[workflow] session ${sessionId}: remote result never landed (no incoming ref) and workspace ${workspaceId} has no commits  returning the issue to Todo so it restarts (#1582)`);
  await closeWorkspace({ database, workspaceId, now, markMerged: false });
  await transitionIssueStatus(database, issueId, todo.id, { now });
  return true;
}
