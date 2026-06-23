import { eq, inArray, or } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../schema/index.js";

export type CascadeDb = LibSQLDatabase<typeof schema>;
type CascadeTx = Parameters<Parameters<CascadeDb["transaction"]>[0]>[0];
type DbOrTx = CascadeDb | CascadeTx;

async function countRows<T extends Record<string, unknown>>(query: Promise<T[]>): Promise<number> {
  const rows = await query;
  return rows.length;
}

async function assertNoRows(label: string, count: Promise<number>): Promise<void> {
  const remaining = await count;
  if (remaining > 0) {
    throw new Error(`Cascade delete left ${remaining} unexpected ${label} row${remaining === 1 ? "" : "s"}`);
  }
}

async function deleteWorkspaceCascadeRows(workspaceId: string, database: DbOrTx): Promise<void> {
  const wsSessions = await database
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(eq(schema.sessions.workspaceId, workspaceId));
  const sessionIds = wsSessions.map((s) => s.id);

  await database.delete(schema.workflowTransitions).where(eq(schema.workflowTransitions.workspaceId, workspaceId));
  await database.delete(schema.testRetryDecisions).where(eq(schema.testRetryDecisions.workspaceId, workspaceId));
  await database.delete(schema.diffComments).where(eq(schema.diffComments.workspaceId, workspaceId));
  await database.delete(schema.issueArtifacts).where(eq(schema.issueArtifacts.workspaceId, workspaceId));
  await database.delete(schema.issueComments).where(eq(schema.issueComments.workspaceId, workspaceId));
  await database.delete(schema.repos).where(eq(schema.repos.workspaceId, workspaceId));
  if (sessionIds.length > 0) {
    await database.delete(schema.sessionMessages).where(inArray(schema.sessionMessages.sessionId, sessionIds));
  }
  await database.delete(schema.sessions).where(eq(schema.sessions.workspaceId, workspaceId));
  await database.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));

  await assertWorkspaceCascadeComplete(workspaceId, sessionIds, database);
}

async function assertWorkspaceCascadeComplete(
  workspaceId: string,
  sessionIds: string[],
  database: DbOrTx,
): Promise<void> {
  await assertNoRows(
    "workspace",
    countRows(database.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId))),
  );
  await assertNoRows(
    "workspace session",
    countRows(database.select({ id: schema.sessions.id }).from(schema.sessions).where(eq(schema.sessions.workspaceId, workspaceId))),
  );
  await assertNoRows(
    "workflow transition",
    countRows(database.select({ id: schema.workflowTransitions.id }).from(schema.workflowTransitions).where(eq(schema.workflowTransitions.workspaceId, workspaceId))),
  );
  await assertNoRows(
    "test retry decision",
    countRows(database.select({ id: schema.testRetryDecisions.id }).from(schema.testRetryDecisions).where(eq(schema.testRetryDecisions.workspaceId, workspaceId))),
  );
  await assertNoRows(
    "diff comment",
    countRows(database.select({ id: schema.diffComments.id }).from(schema.diffComments).where(eq(schema.diffComments.workspaceId, workspaceId))),
  );
  await assertNoRows(
    "workspace issue artifact",
    countRows(database.select({ id: schema.issueArtifacts.id }).from(schema.issueArtifacts).where(eq(schema.issueArtifacts.workspaceId, workspaceId))),
  );
  await assertNoRows(
    "workspace issue comment",
    countRows(database.select({ id: schema.issueComments.id }).from(schema.issueComments).where(eq(schema.issueComments.workspaceId, workspaceId))),
  );
  await assertNoRows(
    "workspace repo",
    countRows(database.select({ id: schema.repos.id }).from(schema.repos).where(eq(schema.repos.workspaceId, workspaceId))),
  );
  if (sessionIds.length > 0) {
    await assertNoRows(
      "session message",
      countRows(
        database
          .select({ sessionId: schema.sessionMessages.sessionId })
          .from(schema.sessionMessages)
          .where(inArray(schema.sessionMessages.sessionId, sessionIds)),
      ),
    );
  }
}

async function deleteIssueCascadeRows(issueId: string, database: DbOrTx): Promise<void> {
  const wsRows = await database.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.issueId, issueId));
  for (const ws of wsRows) {
    await deleteWorkspaceCascadeRows(ws.id, database);
  }

  await database
    .delete(schema.issueDependencies)
    .where(or(eq(schema.issueDependencies.issueId, issueId), eq(schema.issueDependencies.dependsOnId, issueId)));
  await database.delete(schema.issueArtifacts).where(eq(schema.issueArtifacts.issueId, issueId));
  await database.delete(schema.issueComments).where(eq(schema.issueComments.issueId, issueId));
  await database.delete(schema.issueTimeEntries).where(eq(schema.issueTimeEntries.issueId, issueId));
  await database.delete(schema.showdowns).where(eq(schema.showdowns.issueId, issueId));
  await database.delete(schema.issueTags).where(eq(schema.issueTags.issueId, issueId));
  await database.delete(schema.issues).where(eq(schema.issues.id, issueId));

  await assertIssueCascadeComplete(issueId, database);
}

async function assertIssueCascadeComplete(issueId: string, database: DbOrTx): Promise<void> {
  await assertNoRows(
    "issue",
    countRows(database.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.id, issueId))),
  );
  await assertNoRows(
    "issue workspace",
    countRows(database.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.issueId, issueId))),
  );
  await assertNoRows(
    "issue dependency",
    countRows(
      database
        .select({ id: schema.issueDependencies.id })
        .from(schema.issueDependencies)
        .where(or(eq(schema.issueDependencies.issueId, issueId), eq(schema.issueDependencies.dependsOnId, issueId))),
    ),
  );
  await assertNoRows(
    "issue artifact",
    countRows(database.select({ id: schema.issueArtifacts.id }).from(schema.issueArtifacts).where(eq(schema.issueArtifacts.issueId, issueId))),
  );
  await assertNoRows(
    "issue comment",
    countRows(database.select({ id: schema.issueComments.id }).from(schema.issueComments).where(eq(schema.issueComments.issueId, issueId))),
  );
  await assertNoRows(
    "issue time entry",
    countRows(database.select({ id: schema.issueTimeEntries.id }).from(schema.issueTimeEntries).where(eq(schema.issueTimeEntries.issueId, issueId))),
  );
  await assertNoRows(
    "showdown",
    countRows(database.select({ id: schema.showdowns.id }).from(schema.showdowns).where(eq(schema.showdowns.issueId, issueId))),
  );
  await assertNoRows(
    "issue tag",
    countRows(database.select({ id: schema.issueTags.id }).from(schema.issueTags).where(eq(schema.issueTags.issueId, issueId))),
  );
}

/** Cascade delete a workspace and every table that directly references it. */
export async function deleteWorkspaceCascade(workspaceId: string, database: CascadeDb): Promise<void> {
  await database.transaction(async (tx) => {
    await deleteWorkspaceCascadeRows(workspaceId, tx);
  });
}

/** Cascade delete an issue, its workspaces, and every table that references it. */
export async function deleteIssueCascade(issueId: string, database: CascadeDb): Promise<void> {
  await database.transaction(async (tx) => {
    await deleteIssueCascadeRows(issueId, tx);
  });
}
