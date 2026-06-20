import type { Command } from "commander";
import { getPreference, setPreference } from "../../repositories/preferences.repository.js";
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
        await setPreference(key, value);
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
        const value = await getPreference(key);
        console.log(value === null ? `(not set)` : value);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
