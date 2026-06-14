import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { projects } from "./projects.js";
import { drives } from "./drives.js";

/**
 * Structured drive-obstacle telemetry (#803).
 *
 * A "drive obstacle" is a typed friction event the board hits while driving a project
 * hands-off — premature cascade, stall, re-scaffold, silent merge loss, verify-gate
 * failure, over-launch. The point is to *detect* friction as it happens (a queryable,
 * dashboard-feedable event stream) instead of discovering it by hand in a retro.
 *
 * Distinct from the "Autodrive stall watchdog" (which only warns on no-progress) and from
 * `board_health_events` (the Monitor Butler's free-text audit log). This is a small, typed
 * stream keyed on a fixed `kind` taxonomy so each friction class is independently queryable
 * and chartable.
 *
 * Each obstacle optionally links to the `drives` row it occurred under (`driveId`, nullable
 * because friction can be detected outside an explicit drive) and carries an optional
 * `issueNumber` for the ticket it concerns.
 */
export const DRIVE_OBSTACLE_KINDS = [
  "premature_cascade",
  "stall",
  "re_scaffold",
  "silent_merge_loss",
  "verify_gate_failure",
  "over_launch",
] as const;
export type DriveObstacleKind = (typeof DRIVE_OBSTACLE_KINDS)[number];

export const DRIVE_OBSTACLE_SEVERITIES = ["info", "warning", "critical"] as const;
export type DriveObstacleSeverity = (typeof DRIVE_OBSTACLE_SEVERITIES)[number];

export const driveObstacles = sqliteTable("drive_obstacles", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  /** The drive this obstacle occurred under, if any (friction can be detected outside a drive). */
  driveId: text("drive_id").references(() => drives.id, { onDelete: "set null" }),
  /** The typed friction class — one of DRIVE_OBSTACLE_KINDS. */
  kind: text("kind").notNull().$type<DriveObstacleKind>(),
  /** info | warning | critical — for dashboard colour-coding and filtering. */
  severity: text("severity").notNull().$type<DriveObstacleSeverity>().default("warning"),
  /** Issue number this obstacle relates to, if applicable. */
  issueNumber: integer("issue_number"),
  /** Human-readable one-line description. */
  summary: text("summary").notNull(),
  /** Optional JSON blob with structured context (ids, counts, branch names). */
  details: text("details"),
  detectedAt: text("detected_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  projectIdIdx: index("idx_drive_obstacles_project_id").on(table.projectId),
  driveIdIdx: index("idx_drive_obstacles_drive_id").on(table.driveId),
  kindIdx: index("idx_drive_obstacles_kind").on(table.kind),
}));

export const driveObstaclesRelations = relations(driveObstacles, ({ one }) => ({
  project: one(projects, {
    fields: [driveObstacles.projectId],
    references: [projects.id],
  }),
  drive: one(drives, {
    fields: [driveObstacles.driveId],
    references: [drives.id],
  }),
}));
