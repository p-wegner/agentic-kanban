import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { sessions } from "./sessions.js";

export const sessionMessages = sqliteTable("session_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // ON DELETE cascade was added to the live DB by migration 0010_session_messages_cascade
  // but never reflected here; the schema must declare it so the two agree (arch-review #881).
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // stdout | stderr | exit | bisect
  data: text("data"),
  exitCode: text("exit_code"),
  // Agent provider (claude | codex | copilot | pi) that produced this row, so
  // offline transcript/summary parsing routes lines to the correct per-provider
  // parser instead of sniffing per-event (arch-review §2.4). Nullable + forward-only:
  // legacy rows stay NULL and fall back to per-event provider detection (0099).
  provider: text("provider"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  sessionIdCreatedAtIdx: index("idx_session_messages_session_id_created_at").on(table.sessionId, table.createdAt),
}));

export const sessionMessagesRelations = relations(sessionMessages, ({ one }) => ({
  session: one(sessions, {
    fields: [sessionMessages.sessionId],
    references: [sessions.id],
  }),
}));
