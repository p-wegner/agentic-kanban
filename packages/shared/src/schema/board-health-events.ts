import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { projects } from "./projects.js";

/**
 * Audit log of autonomous Monitor Butler activity. One row per discrete action the
 * Monitor Butler takes (or decides not to take) on a cron cycle — merging clean
 * work, restarting a stale agent, pulling a ready ticket, or just observing.
 *
 * This is deliberately a generic event log (not a structured action table) because
 * the Monitor Butler interprets natural-language strategies and we cannot enumerate
 * every action shape up front. `eventType` is a coarse category for filtering;
 * `summary` is the human-readable line; `details` holds optional JSON context.
 */
export const boardHealthEvents = sqliteTable("board_health_events", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  /** Cron run that produced this event — groups all events from one monitor cycle. */
  cycleId: text("cycle_id").notNull(),
  /** Coarse category: cycle_start | cycle_end | observation | action | error. */
  eventType: text("event_type").notNull(),
  /** Human-readable one-line description of the event. */
  summary: text("summary").notNull(),
  /** Optional JSON blob with structured context (stats, ids, tool names). */
  details: text("details"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  projectIdIdx: index("idx_board_health_events_project_id").on(table.projectId),
  cycleIdIdx: index("idx_board_health_events_cycle_id").on(table.cycleId),
}));

export const boardHealthEventsRelations = relations(boardHealthEvents, ({ one }) => ({
  project: one(projects, {
    fields: [boardHealthEvents.projectId],
    references: [projects.id],
  }),
}));
