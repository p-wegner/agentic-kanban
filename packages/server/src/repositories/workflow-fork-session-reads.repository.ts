/**
 * The fork engine's CROSS-AGGREGATE reads into `sessions` / `session_messages`.
 *
 * Split out of `workflow-fork.repository.ts` (#722, shrink-only cohesion baseline). These
 * five are the only fork-engine queries that leave the `workspaces`/`issues` aggregates,
 * and they are kept together for exactly that reason: the table-ownership ratchet
 * (`repository-table-ownership.test.ts`) counts non-owner reads of `sessions` per FILE, so
 * scattering them over the other fork modules would split one table's access across four
 * baseline entries instead of one.
 *
 * Two consumers, one shape of question ("what sessions does this child workspace have?"):
 * the spec-driven phase launcher (is a session already running / did this phase already
 * run?) and the join/consolidate step (harvest the child's stdout transcript).
 */
import { and, eq } from "drizzle-orm";
import { sessionMessages, sessions } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function selectRunningSessionForWorkspace(workspaceId: string, database: Database = db) {
  return database
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.status, "running")))
    .limit(1);
}

export async function selectRunningSessionsForWorkspace(workspaceId: string, database: Database = db) {
  return database.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.status, "running")));
}

export async function selectPhaseSession(
  workspaceId: string,
  triggerType: string,
  database: Database = db,
) {
  return database
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.triggerType, triggerType)))
    .limit(1);
}

export async function selectSessionsForWorkspaceOrdered(workspaceId: string, database: Database = db) {
  return database.select({ id: sessions.id }).from(sessions).where(eq(sessions.workspaceId, workspaceId)).orderBy(sessions.startedAt);
}

export async function selectStdoutSessionMessages(sessionId: string, database: Database = db) {
  return database
    .select({ data: sessionMessages.data })
    .from(sessionMessages)
    .where(and(eq(sessionMessages.sessionId, sessionId), eq(sessionMessages.type, "stdout")))
    .orderBy(sessionMessages.createdAt);
}
