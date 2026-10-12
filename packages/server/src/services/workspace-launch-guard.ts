import type { Database } from "../db/index.js";
import { getSessionsForWorkspace } from "../repositories/workspace-session.repository.js";
import { WorkspaceError } from "./workspace-error.js";

/**
 * #1425: a workspace has ONE builder at a time. Two builders on one branch race each other's
 * pushes and the loser's work is lost. `running` is the only live session status (a session
 * row is inserted `running` when it starts); bisect sessions run their own scratch checkout
 * and are not builders.
 */
export async function findRunningBuilderSessionIds(database: Database, workspaceId: string): Promise<string[]> {
  const rows = await getSessionsForWorkspace(workspaceId, database);
  return rows.filter((s) => s.status === "running" && s.executor !== "auto-bisect").map((s) => s.id);
}

/**
 * Refuse a launch while a builder session is live, unless the caller passed `replace: true`
 * (then the old sessions are stopped first). `force`/`fromTrain` callers keep their old,
 * unguarded behavior.
 */
export async function guardAgainstSecondBuilder(
  database: Database,
  workspaceId: string,
  body: Record<string, unknown>,
  stopSession: (sessionId: string) => Promise<unknown>,
): Promise<void> {
  if (body.force === true || body.fromTrain === true) return;
  const running = await findRunningBuilderSessionIds(database, workspaceId);
  if (running.length === 0) return;
  if (body.replace !== true) {
    throw new WorkspaceError(
      `Workspace already has a running session (${running.join(", ")}). ` +
        `Pass replace: true to stop it and launch a new one, or stop the workspace first.`,
      "CONFLICT",
      { reason: "SESSION_ALREADY_RUNNING", sessionIds: running, sessionId: running[0] },
    );
  }
  console.warn(`[workspace-session] launch replace=true: stopping ${running.join(", ")} for workspaceId=${workspaceId}`);
  for (const sid of running) await stopSession(sid);
}
