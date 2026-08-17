import { sessions, sessionMessages } from "@agentic-kanban/shared/schema";
import { eq, desc, and, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

// #502: one definition, in workspace-reads (this copy already had its shape, untyped).
export { getWorkspaceById } from "./workspace-reads.repository.js";

export async function getWorkspaceSessions(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select()
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId))
    .orderBy(desc(sessions.startedAt));
}

export async function getAssistantMessagesForSessions(
  sessionIds: string[],
  database: Database = db,
) {
  return database
    .select({ sessionId: sessionMessages.sessionId, data: sessionMessages.data, createdAt: sessionMessages.createdAt })
    .from(sessionMessages)
    .where(and(
      inArray(sessionMessages.sessionId, sessionIds),
      eq(sessionMessages.type, "assistant"),
    ))
    .orderBy(desc(sessionMessages.createdAt));
}
