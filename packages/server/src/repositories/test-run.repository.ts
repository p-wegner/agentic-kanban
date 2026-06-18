import { eq, desc, gte, sql } from "drizzle-orm";
import { testRuns, flakyTestPins, sessionMessages } from "@agentic-kanban/shared/schema";
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

export async function getFlakyAggregates(
  cutoff: string,
  minRuns: number,
  database: Database = db,
) {
  return database
    .select({
      testName: testRuns.testName,
      file: testRuns.file,
      suite: testRuns.suite,
      runner: testRuns.runner,
      totalRuns: sql<number>`count(*)`,
      passCount: sql<number>`sum(case when ${testRuns.passed} = 1 then 1 else 0 end)`,
      failCount: sql<number>`sum(case when ${testRuns.passed} = 0 then 1 else 0 end)`,
      lastSeen: sql<string>`max(${testRuns.recordedAt})`,
      lastError: sql<string | null>`(
        select t2.error_message from test_runs t2
        where t2.test_name = ${testRuns.testName} and t2.passed = 0
        order by t2.recorded_at desc limit 1
      )`,
    })
    .from(testRuns)
    .where(gte(testRuns.recordedAt, cutoff))
    .groupBy(testRuns.testName, testRuns.file, testRuns.suite, testRuns.runner)
    .having(sql`count(*) >= ${minRuns}`);
}

export async function getFlakyPinNames(
  database: Database = db,
) {
  return database.select({ testName: flakyTestPins.testName }).from(flakyTestPins);
}

export async function insertFlakyPin(
  testName: string,
  file: string | null,
  pinnedAt: string,
  database: Database = db,
): Promise<void> {
  await database
    .insert(flakyTestPins)
    .values({ testName, file, pinnedAt })
    .onConflictDoNothing();
}

export async function deleteFlakyPin(
  testName: string,
  database: Database = db,
): Promise<void> {
  await database.delete(flakyTestPins).where(eq(flakyTestPins.testName, testName));
}

export async function getPinnedTestRows(
  database: Database = db,
) {
  return database
    .select({ testName: flakyTestPins.testName, file: flakyTestPins.file, pinnedAt: flakyTestPins.pinnedAt })
    .from(flakyTestPins)
    .orderBy(desc(flakyTestPins.pinnedAt));
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
