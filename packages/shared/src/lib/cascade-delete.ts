import { and, eq, inArray, like, or } from "drizzle-orm";
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
    await database.delete(schema.testRuns).where(inArray(schema.testRuns.sessionId, sessionIds));
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
    await assertNoRows(
      "test run",
      countRows(
        database
          .select({ sessionId: schema.testRuns.sessionId })
          .from(schema.testRuns)
          .where(inArray(schema.testRuns.sessionId, sessionIds)),
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

/**
 * Delete a project's entire subtree inside the CALLER's transaction handle.
 *
 * Single home for project-cascade knowledge (#949) — previously a second
 * hand-maintained table list lived in server/repositories/project.repository.ts
 * with N independently-committing per-issue transactions followed by ~13
 * un-wrapped deletes, so a crash mid-walk left a half-gutted project.
 *
 * Coverage of every table with a projectId column (schema-derived; the
 * project-cascade completeness gate pins this set):
 *   - issues (+ their full workspace/session subtree) — via deleteIssueCascadeRows
 *   - drive_obstacles, drives — deleted BEFORE issues so we never rely on the
 *     drives.meta_issue_id `set null` action existing in a drifted live DB (#858)
 *   - scheduled_run_history, scheduled_runs — history first (FK to runs); runs
 *     before agent_skills (scheduled_runs.skill_id FK)
 *   - workflow_edges, workflow_nodes, workflow_templates — children explicitly
 *     (belt-and-braces vs FK-action drift), before agent_skills (nodes.skill_id FK).
 *     Built-in/global templates (projectId NULL) are untouched.
 *   - agent_skills (project-scoped only; global NULL-projectId skills survive)
 *   - flaky_tests, quality_metrics, board_health_events, project_script_shortcuts
 *   - milestones — after issues (issues.milestone_id FK)
 *   - repos — project-level rows; workspace-scoped rows already went with their workspace
 *   - project_statuses — after issues (issues.status_id FK)
 *   - preferences — the `activeProjectId` pointer row, plus every per-project
 *     templated key (`start_mode_<id>`, `board_strategy_<id>`, …): any key ending in
 *     `_<projectId>` is by construction project-scoped, so one LIKE delete covers the
 *     whole class without duplicating the server's PROJECT_SCOPED_KEY_PREFIXES table.
 *     Done INSIDE the tx (stricter than the old behavior, which cleaned nothing but
 *     the activeProjectId row).
 *   - runtime_state — the same suffix delete for per-project runtime rows
 *     (`butler_session_<id>`, `butler_session_history_<id>`), which moved out of
 *     `preferences` in #975.
 * Intentionally retained: nothing — no project-referencing table survives.
 * (tags are global, session output temp files are filesystem, not DB.)
 */
async function deleteProjectCascadeRows(projectId: string, database: DbOrTx): Promise<void> {
  // Drive telemetry first: obstacles reference drives (set null) and drives
  // reference issues (set null) — explicit deletes avoid depending on either
  // action being present in an older live DB.
  await database.delete(schema.driveObstacles).where(eq(schema.driveObstacles.projectId, projectId));
  await database.delete(schema.drives).where(eq(schema.drives.projectId, projectId));

  const projectIssues = await database
    .select({ id: schema.issues.id })
    .from(schema.issues)
    .where(eq(schema.issues.projectId, projectId));
  for (const issue of projectIssues) {
    await deleteIssueCascadeRows(issue.id, database);
  }

  await database.delete(schema.scheduledRunHistory).where(eq(schema.scheduledRunHistory.projectId, projectId));
  await database.delete(schema.scheduledRuns).where(eq(schema.scheduledRuns.projectId, projectId));
  await database.delete(schema.projectScriptShortcuts).where(eq(schema.projectScriptShortcuts.projectId, projectId));

  const templates = await database
    .select({ id: schema.workflowTemplates.id })
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.projectId, projectId));
  const templateIds = templates.map((t) => t.id);
  if (templateIds.length > 0) {
    await database.delete(schema.workflowEdges).where(inArray(schema.workflowEdges.templateId, templateIds));
    await database.delete(schema.workflowNodes).where(inArray(schema.workflowNodes.templateId, templateIds));
    await database.delete(schema.workflowTemplates).where(inArray(schema.workflowTemplates.id, templateIds));
  }

  // defaultSkillId has no declared FK, but null it before deleting the project's
  // skills in case an older live DB grew a constraint (FK-action drift, #858).
  await database.update(schema.projects).set({ defaultSkillId: null }).where(eq(schema.projects.id, projectId));
  await database.delete(schema.agentSkills).where(eq(schema.agentSkills.projectId, projectId));

  await database.delete(schema.flakyTests).where(eq(schema.flakyTests.projectId, projectId));
  await database.delete(schema.qualityMetrics).where(eq(schema.qualityMetrics.projectId, projectId));
  await database.delete(schema.boardHealthEvents).where(eq(schema.boardHealthEvents.projectId, projectId));
  await database.delete(schema.milestones).where(eq(schema.milestones.projectId, projectId));
  await database.delete(schema.repos).where(eq(schema.repos.projectId, projectId));
  await database.delete(schema.projectStatuses).where(eq(schema.projectStatuses.projectId, projectId));

  await database
    .delete(schema.preferences)
    .where(and(eq(schema.preferences.key, "activeProjectId"), eq(schema.preferences.value, projectId)));
  await database.delete(schema.preferences).where(like(schema.preferences.key, `%_${projectId}`));

  // Per-project RUNTIME STATE (#975): butler_session_<id> / butler_session_history_<id>
  // moved out of `preferences` into `runtime_state`, so the same suffix delete must
  // run there too or those rows orphan on project deletion.
  await database.delete(schema.runtimeState).where(like(schema.runtimeState.key, `%_${projectId}`));

  await database.delete(schema.projects).where(eq(schema.projects.id, projectId));

  await assertProjectCascadeComplete(projectId, database);
}

async function assertProjectCascadeComplete(projectId: string, database: DbOrTx): Promise<void> {
  await assertNoRows(
    "project",
    countRows(database.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId))),
  );
  const byProjectId: Array<[string, () => Promise<number>]> = [
    ["project issue", () => countRows(database.select({ id: schema.issues.id }).from(schema.issues).where(eq(schema.issues.projectId, projectId)))],
    ["drive obstacle", () => countRows(database.select({ id: schema.driveObstacles.id }).from(schema.driveObstacles).where(eq(schema.driveObstacles.projectId, projectId)))],
    ["drive", () => countRows(database.select({ id: schema.drives.id }).from(schema.drives).where(eq(schema.drives.projectId, projectId)))],
    ["scheduled run history", () => countRows(database.select({ id: schema.scheduledRunHistory.id }).from(schema.scheduledRunHistory).where(eq(schema.scheduledRunHistory.projectId, projectId)))],
    ["scheduled run", () => countRows(database.select({ id: schema.scheduledRuns.id }).from(schema.scheduledRuns).where(eq(schema.scheduledRuns.projectId, projectId)))],
    ["project script shortcut", () => countRows(database.select({ id: schema.projectScriptShortcuts.id }).from(schema.projectScriptShortcuts).where(eq(schema.projectScriptShortcuts.projectId, projectId)))],
    ["workflow template", () => countRows(database.select({ id: schema.workflowTemplates.id }).from(schema.workflowTemplates).where(eq(schema.workflowTemplates.projectId, projectId)))],
    ["agent skill", () => countRows(database.select({ id: schema.agentSkills.id }).from(schema.agentSkills).where(eq(schema.agentSkills.projectId, projectId)))],
    ["flaky test", () => countRows(database.select({ id: schema.flakyTests.id }).from(schema.flakyTests).where(eq(schema.flakyTests.projectId, projectId)))],
    ["quality metric", () => countRows(database.select({ id: schema.qualityMetrics.id }).from(schema.qualityMetrics).where(eq(schema.qualityMetrics.projectId, projectId)))],
    ["board health event", () => countRows(database.select({ id: schema.boardHealthEvents.id }).from(schema.boardHealthEvents).where(eq(schema.boardHealthEvents.projectId, projectId)))],
    ["milestone", () => countRows(database.select({ id: schema.milestones.id }).from(schema.milestones).where(eq(schema.milestones.projectId, projectId)))],
    ["project repo", () => countRows(database.select({ id: schema.repos.id }).from(schema.repos).where(eq(schema.repos.projectId, projectId)))],
    ["project status", () => countRows(database.select({ id: schema.projectStatuses.id }).from(schema.projectStatuses).where(eq(schema.projectStatuses.projectId, projectId)))],
    ["project-scoped preference", () => countRows(database.select({ key: schema.preferences.key }).from(schema.preferences).where(like(schema.preferences.key, `%_${projectId}`)))],
    ["project-scoped runtime state", () => countRows(database.select({ key: schema.runtimeState.key }).from(schema.runtimeState).where(like(schema.runtimeState.key, `%_${projectId}`)))],
  ];
  for (const [label, count] of byProjectId) {
    await assertNoRows(label, count());
  }
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

/**
 * Cascade delete a project and everything that references it in ONE transaction.
 *
 * Atomicity (#949): the per-issue subtrees participate in the SAME outer
 * transaction — libsql/Drizzle does not support nested `db.transaction()` calls,
 * so the issue walk is invoked via its tx-parameterized `deleteIssueCascadeRows`
 * building block rather than the transaction-opening `deleteIssueCascade`. A crash
 * anywhere mid-walk rolls the whole project back instead of leaving it half-gutted.
 */
export async function deleteProjectCascade(projectId: string, database: CascadeDb): Promise<void> {
  await database.transaction(async (tx) => {
    await deleteProjectCascadeRows(projectId, tx);
  });
}
