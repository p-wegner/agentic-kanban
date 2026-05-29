import { sqliteTable, text, real, index } from "drizzle-orm/sqlite-core";

export const failurePatterns = sqliteTable("failure_patterns", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  errorClass: text("error_class"),
  keywords: text("keywords").notNull().default(""),
  description: text("description"),
  rootCause: text("root_cause"),
  fix: text("fix"),
  sourceType: text("source_type").notNull().default("learning"),
  sourceRef: text("source_ref"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  errorClassIdx: index("idx_failure_patterns_error_class").on(table.errorClass),
  sourceTypeIdx: index("idx_failure_patterns_source_type").on(table.sourceType),
}));
