import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { projects } from "./projects.js";
import { issues } from "./issues.js";

/**
 * A "Drive" is a first-class record of an autonomous epic push: the board (or an
 * agent following the `drive-new-project` skill) drives a project toward a target
 * under a completion contract. Making it a record — rather than living only in the
 * skill prose + agent memory — means a drive is observable, resumable, and
 * queryable, and survives a server restart.
 */
export const DRIVE_STATUSES = ["active", "completed", "abandoned"] as const;
export type DriveStatus = (typeof DRIVE_STATUSES)[number];

export const drives = sqliteTable("drives", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  // The meta/epic issue this drive is pushing toward completion (nullable: a drive
  // may be created before its meta-ticket exists).
  metaIssueId: text("meta_issue_id").references(() => issues.id, { onDelete: "set null" }),
  // Free-text goal the drive is steering toward (what "done" looks like).
  target: text("target").notNull(),
  // The completion contract: the explicit, checkable condition for finishing.
  completionContract: text("completion_contract"),
  status: text("status").notNull().$type<DriveStatus>().default("active"),
  startedAt: text("started_at").notNull().$defaultFn(() => new Date().toISOString()),
  finishedAt: text("finished_at"),
}, (table) => ({
  projectIdIdx: index("idx_drives_project_id").on(table.projectId),
  metaIssueIdIdx: index("idx_drives_meta_issue_id").on(table.metaIssueId),
}));

export const drivesRelations = relations(drives, ({ one }) => ({
  project: one(projects, {
    fields: [drives.projectId],
    references: [projects.id],
  }),
  metaIssue: one(issues, {
    fields: [drives.metaIssueId],
    references: [issues.id],
  }),
}));
