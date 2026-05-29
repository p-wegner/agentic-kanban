import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const testRuns = sqliteTable("test_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull(),
  commitSha: text("commit_sha"),
  testName: text("test_name").notNull(),
  file: text("file"),
  suite: text("suite"),
  passed: integer("passed", { mode: "boolean" }).notNull(),
  durationMs: integer("duration_ms"),
  errorMessage: text("error_message"),
  runner: text("runner").notNull().default("vitest"),
  recordedAt: text("recorded_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  sessionIdIdx: index("idx_test_runs_session_id").on(table.sessionId),
  testNameIdx: index("idx_test_runs_test_name").on(table.testName),
  fileIdx: index("idx_test_runs_file").on(table.file),
}));

export const flakyTestPins = sqliteTable("flaky_test_pins", {
  testName: text("test_name").primaryKey(),
  file: text("file"),
  pinnedAt: text("pinned_at").notNull().$defaultFn(() => new Date().toISOString()),
  pinnedBy: text("pinned_by"),
});
