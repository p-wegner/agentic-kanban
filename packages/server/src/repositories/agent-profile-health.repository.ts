import { preferences } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getAllPreferences as canonicalGetAllPreferences } from "./preferences.repository.js";

export type PreferenceRow = typeof preferences.$inferSelect;

/** #613: delegates to the canonical reader — see preferences.repository. */
export async function getAllPreferences(database: Database = db) {
  return canonicalGetAllPreferences(database);
}
