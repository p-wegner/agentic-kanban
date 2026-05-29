import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { projects } from "./projects.js";
import { sessions } from "./sessions.js";
import { workspaces } from "./workspaces.js";

/**
 * Registry of known flaky tests per project.
 * Each entry describes a test that is known to fail non-deterministically.
 */
export const flakyTests = sqliteTable("flaky_tests", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  /** Test name / description (substring match). */
  testName: text("test_name").notNull(),
  /** Path to the file containing the test (used for dep-closure check). Null = match any file. */
  testFilePath: text("test_file_path"),
  /** Optional regex pattern to additionally match against the error message. */
  errorPattern: text("error_pattern"),
  /** Human-readable note about why this test is flaky. */
  reason: text("reason"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  projectIdIdx: index("idx_flaky_tests_project_id").on(table.projectId),
}));

export const flakyTestsRelations = relations(flakyTests, ({ one }) => ({
  project: one(projects, {
    fields: [flakyTests.projectId],
    references: [projects.id],
  }),
}));

/**
 * Per-test decision log emitted by the flake classifier during a session.
 * One record per (session, testName) attempted classification.
 */
export const testRetryDecisions = sqliteTable("test_retry_decisions", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  /** Name/description of the failing test. */
  testName: text("test_name").notNull(),
  /** Classifier decision: flake | suspicious | real */
  decision: text("decision").notNull(),
  /** Confidence score [0, 1]. */
  confidence: real("confidence").notNull(),
  /** Number of times this test has been retried so far. */
  retryCount: integer("retry_count").notNull().default(0),
  /**
   * Final outcome once all retries are exhausted:
   * - confirmed_flake: still failed on final attempt (was a real flake)
   * - confirmed_real: passed on a retry (was indeed non-deterministic) 
   *   Note: counter-intuitively, "confirmed_flake" means it kept failing = real regression
   *   "confirmed_real" means it passed on retry = was a flake
   * - pending: retries not yet exhausted / outcome unknown
   */
  finalOutcome: text("final_outcome").notNull().default("pending"),
  /** JSON snapshot of the inputs fed to the classifier. */
  classifierInput: text("classifier_input"),
  /** Human-readable reasoning from the classifier. */
  reasoning: text("reasoning"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  sessionIdIdx: index("idx_test_retry_decisions_session_id").on(table.sessionId),
  workspaceIdIdx: index("idx_test_retry_decisions_workspace_id").on(table.workspaceId),
}));

export const testRetryDecisionsRelations = relations(testRetryDecisions, ({ one }) => ({
  session: one(sessions, {
    fields: [testRetryDecisions.sessionId],
    references: [sessions.id],
  }),
  workspace: one(workspaces, {
    fields: [testRetryDecisions.workspaceId],
    references: [workspaces.id],
  }),
}));
