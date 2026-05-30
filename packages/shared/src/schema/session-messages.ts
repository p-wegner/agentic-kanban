import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { sessions } from "./sessions.js";

export const sessionMessages = sqliteTable("session_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull().references(() => sessions.id),
  type: text("type").notNull(), // stdout | stderr | exit | bisect
  data: text("data"),
  exitCode: text("exit_code"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  sessionIdIdx: index("idx_session_messages_session_id").on(table.sessionId),
  createdAtIdx: index("idx_session_messages_created_at").on(table.createdAt),
}));

export const sessionMessagesRelations = relations(sessionMessages, ({ one }) => ({
  session: one(sessions, {
    fields: [sessionMessages.sessionId],
    references: [sessions.id],
  }),
}));
