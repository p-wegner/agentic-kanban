import type { Command } from "commander";
import { db } from "../../db/index.js";
import { preferences } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { runMigrations } from "../shared.js";

export function registerPreferencesCommand(program: Command) {
  const prefCmd = program
    .command("preferences")
    .description("Manage CLI preferences.\n\nSubcommands: get, set")
    .addHelpText("after", `
Examples:
  $ agentic-kanban preferences get projects_base_path
  $ agentic-kanban preferences set projects_base_path /path/to/projects
`);

  prefCmd
    .command("set <key> <value>")
    .description("Set a preference value.")
    .action(async (key: string, value: string) => {
      try {
        await runMigrations();
        const now = new Date().toISOString();
        await db
          .insert(preferences)
          .values({ key, value, updatedAt: now })
          .onConflictDoUpdate({ target: preferences.key, set: { value, updatedAt: now } });
        console.log(`Set ${key} = ${value}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  prefCmd
    .command("get <key>")
    .description("Get a preference value.")
    .action(async (key: string) => {
      try {
        await runMigrations();
        const rows = await db.select().from(preferences).where(eq(preferences.key, key)).limit(1);
        if (rows.length === 0) {
          console.log(`(not set)`);
        } else {
          console.log(rows[0].value);
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
