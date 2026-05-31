import { sqliteTable, text, real, index } from "drizzle-orm/sqlite-core";
import { projects } from "./projects.js";

export const qualityMetrics = sqliteTable("quality_metrics", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  metricKey: text("metric_key").notNull(),
  value: real("value").notNull(),
  unit: text("unit"),
  meta: text("meta"),
  collectedAt: text("collected_at").notNull().$defaultFn(() => new Date().toISOString()),
  commitSha: text("commit_sha"),
}, (table) => ({
  projectMetricCollectedIdx: index("idx_quality_metrics_project_metric_collected")
    .on(table.projectId, table.metricKey, table.collectedAt),
}));
