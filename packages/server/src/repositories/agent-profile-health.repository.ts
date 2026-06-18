import { preferences } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export type PreferenceRow = typeof preferences.$inferSelect;

export async function getAllPreferences(database: Database = db): Promise<PreferenceRow[]> {
  return database.select().from(preferences);
}
