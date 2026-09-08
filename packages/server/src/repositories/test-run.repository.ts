import { eq, desc } from "drizzle-orm";
import { testRuns, sessionMessages } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function insertTestRunBatch(
  rows: Array<{
    sessionId: string;
    commitSha: string | null;
    testName: string;
    file: string | null;
    suite: string | null;
    passed: boolean;
    durationMs: number | null;
    errorMessage: string | null;
    runner: string;
    recordedAt: string;
  }>,
  database: Database = db,
): Promise<void> {
  await database.insert(testRuns).values(rows);
}

export async function getTestRunIdForSession(
  sessionId: string,
  database: Database = db,
) {
  return database
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(eq(testRuns.sessionId, sessionId))
    .limit(1);
}

export async function getSessionStdoutMessages(
  sessionId: string,
  database: Database = db,
) {
  return database
    .select({ type: sessionMessages.type, data: sessionMessages.data })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(sessionMessages.id);
}
