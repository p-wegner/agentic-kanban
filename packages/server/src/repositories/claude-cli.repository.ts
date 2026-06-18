import { preferences } from "@agentic-kanban/shared/schema";
import { inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * Agent-launch preference rows (key/value) used to resolve the Claude/Codex CLI
 * invocation: agent_command, claude_profile, provider, codex_profile.
 */
export async function getClaudeCliPreferences(
  database: Database = db,
) {
  return database
    .select({ key: preferences.key, value: preferences.value })
    .from(preferences)
    .where(inArray(preferences.key, ["agent_command", "claude_profile", "provider", "codex_profile"]));
}
