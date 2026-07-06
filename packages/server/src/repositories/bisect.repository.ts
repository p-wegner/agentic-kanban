import { eq } from "drizzle-orm";
import { issues, sessionMessages, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { sanitizeUtf8 } from "@agentic-kanban/shared/lib/sanitize-utf8";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/** Persist a single session message row (fallback when no live session manager). */
export async function insertSessionMessage(
  values: { sessionId: string; type: string; data: string | null; exitCode: string | null },
  database: Database = db,
): Promise<void> {
  await database.insert(sessionMessages).values({
    ...values,
    data: values.data == null ? null : sanitizeUtf8(values.data),
  });
}

/** Workspace working-dir + base commit + owning project, for a bisect run. */
export async function getBisectRunContext(
  workspaceId: string,
  database: Database = db,
) {
  const rows = await database
    .select({
      workingDir: workspaces.workingDir,
      baseCommitSha: workspaces.baseCommitSha,
      projectId: issues.projectId,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return rows[0] ?? null;
}

/** Workspace working-dir + owning project, for starting a bisect session. */
export async function getBisectStartContext(
  workspaceId: string,
  database: Database = db,
) {
  const rows = await database
    .select({ workingDir: workspaces.workingDir, projectId: issues.projectId })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return rows[0] ?? null;
}

/** All sessions (id + status) for a workspace — used to reject overlapping runs. */
export async function getSessionsForWorkspace(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select({ id: sessions.id, status: sessions.status })
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId));
}

/** Insert a new auto-bisect session row. */
export async function insertBisectSession(
  values: { id: string; workspaceId: string; startedAt: string },
  database: Database = db,
): Promise<void> {
  await database.insert(sessions).values({
    id: values.id,
    workspaceId: values.workspaceId,
    executor: "auto-bisect",
    status: "running",
    startedAt: values.startedAt,
    endedAt: null,
    exitCode: null,
    triggerType: "bisect",
  });
}

/** Mark a session terminal (status/endedAt/exitCode). */
export async function setSessionTerminal(
  sessionId: string,
  status: string,
  endedAt: string,
  exitCode: string,
  database: Database = db,
): Promise<void> {
  await database.update(sessions)
    .set({ status, endedAt, exitCode })
    .where(eq(sessions.id, sessionId));
}
