import { eq, desc, inArray } from "drizzle-orm";
import { flakyTests, testRetryDecisions, workspaces as workspacesTable, issues } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectById } from "./project.repository.js";

export async function listFlakyTestsByProject(
  projectId: string,
  database: Database = db,
) {
  return database
    .select()
    .from(flakyTests)
    .where(eq(flakyTests.projectId, projectId))
    .orderBy(flakyTests.createdAt);
}

export async function insertFlakyTest(
  values: {
    id: string;
    projectId: string;
    testName: string;
    testFilePath: string | null;
    errorPattern: string | null;
    reason: string | null;
    createdAt: string;
  },
  database: Database = db,
): Promise<void> {
  await database.insert(flakyTests).values(values);
}

export async function getFlakyTestById(
  id: string,
  database: Database = db,
) {
  const [row] = await database.select().from(flakyTests).where(eq(flakyTests.id, id));
  return row;
}

export async function deleteFlakyTestById(
  id: string,
  database: Database = db,
): Promise<void> {
  await database.delete(flakyTests).where(eq(flakyTests.id, id));
}

export async function getProjectRetrySettings(
  projectId: string,
  database: Database = db,
) {
  const project = await getProjectById(projectId, database);
  return project ? { autoRetryFlakes: project.autoRetryFlakes, maxRetries: project.maxRetries } : undefined;
}

export async function listKnownFlakyByProject(
  projectId: string,
  database: Database = db,
) {
  return database
    .select()
    .from(flakyTests)
    .where(eq(flakyTests.projectId, projectId));
}

export async function insertTestRetryDecision(
  values: {
    id: string;
    sessionId: string;
    workspaceId: string;
    testName: string;
    decision: string;
    confidence: number;
    retryCount: number;
    finalOutcome: string;
    classifierInput: string;
    reasoning: string;
    createdAt: string;
    updatedAt: string;
  },
  database: Database = db,
): Promise<void> {
  await database.insert(testRetryDecisions).values(values);
}

export async function updateTestRetryDecision(
  decisionId: string,
  values: { retryCount: number; finalOutcome: string; updatedAt: string },
  database: Database = db,
): Promise<void> {
  await database.update(testRetryDecisions)
    .set(values)
    .where(eq(testRetryDecisions.id, decisionId));
}

export async function getTestRetryDecisionById(
  decisionId: string,
  database: Database = db,
) {
  const [updated] = await database.select().from(testRetryDecisions).where(eq(testRetryDecisions.id, decisionId));
  return updated;
}

export async function getDecisionsBySession(
  sessionId: string,
  database: Database = db,
) {
  return database
    .select()
    .from(testRetryDecisions)
    .where(eq(testRetryDecisions.sessionId, sessionId))
    .orderBy(desc(testRetryDecisions.createdAt));
}

export async function getDecisionsByWorkspace(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select()
    .from(testRetryDecisions)
    .where(eq(testRetryDecisions.workspaceId, workspaceId))
    .orderBy(desc(testRetryDecisions.createdAt));
}

export async function getWorkspaceIdsByProject(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({ id: workspacesTable.id })
    .from(workspacesTable)
    .innerJoin(issues, eq(workspacesTable.issueId, issues.id))
    .where(eq(issues.projectId, projectId));
}

export async function getDecisionsByWorkspaceIds(
  wsIds: string[],
  database: Database = db,
) {
  return database
    .select()
    .from(testRetryDecisions)
    .where(inArray(testRetryDecisions.workspaceId, wsIds));
}
