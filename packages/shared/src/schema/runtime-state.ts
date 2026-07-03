import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Ephemeral / unbounded RUNTIME STATE — deliberately separate from `preferences`
 * (the closed, registry-backed CONFIG set). See ticket #975: mixing runtime state
 * into `preferences` made "what settings exist" unanswerable from the schema, gave
 * the `getSettings` whitelist a false sense of a closed set, and let per-question
 * answered markers grow the table without bound.
 *
 * This table holds the state that is NOT config: per-`toolUseId` agent-question
 * answered/dismissed markers and cached recommendations (unbounded row growth),
 * butler SDK session ids + rolling history, agent-profile launch-failure payloads,
 * and rate-limit timestamps (e.g. `backlog_empty_last_run`).
 *
 * A row MAY carry an `expiresAt` (ISO string) so unbounded namespaces can be swept
 * by `cleanupExpiredRuntimeState`. This table is NOT part of config export/backup.
 */
export const runtimeState = sqliteTable(
  "runtime_state",
  {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
    /** ISO timestamp after which the row is eligible for TTL cleanup; null = never expires. */
    expiresAt: text("expires_at"),
  },
  (t) => ({
    expiresAtIdx: index("runtime_state_expires_at_idx").on(t.expiresAt),
  }),
);
