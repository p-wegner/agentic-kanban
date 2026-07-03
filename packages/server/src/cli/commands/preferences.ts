import type { Command } from "commander";
import { getPreference, setPreference } from "../../repositories/preferences.repository.js";
import type { Database } from "../../db/index.js";
import { PROVIDER_DIVERGENCE_KEYS, createPreferenceService, preferenceService } from "../../services/preference.service.js";
import type { ProviderDivergenceRejection } from "../../services/preference.service.js";
import { runMigrations } from "../shared.js";

function formatDivergence(key: string, value: string, d: ProviderDivergenceRejection): string {
  const bullseye = `${d.bullseyeProvider ?? "?"}:${d.bullseyeProfile ?? ""}`;
  const settings = `${d.settingsProvider ?? "?"}:${d.settingsProfile ?? ""}`;
  return [
    `Refusing to set ${key}=${value}: the write would diverge from the active project's Strategy Bullseye (#903).`,
    `  project:  ${d.projectId}`,
    `  Bullseye: ${bullseye}`,
    `  settings: ${settings} (after this write)`,
    `Change the default via the Strategy Bullseye (board_strategy_<projectId>) / the set-provider-default flow instead, or write a value that agrees with the Bullseye.`,
  ].join("\n");
}

/**
 * CLI-side twin of the #903 write-time provider-divergence guard (#973).
 *
 * `preferences set` used to call the raw repository `setPreference` for ANY key,
 * so one CLI call on `provider`/`*_profile` could recreate the settings/Bullseye
 * drift class that caused a documented multi-cycle stall. Provider/profile keys
 * now go through `updateSettings` — the same projection + loud rejection the
 * settings route uses. Every other key keeps the raw unvalidated write: the CLI
 * is deliberately a power tool for arbitrary keys (cooldown stamps, dynamic
 * per-project prefs, activeProjectId, …).
 */
export async function setPreferenceGuarded(
  key: string,
  value: string,
  database?: Database,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!PROVIDER_DIVERGENCE_KEYS.has(key)) {
    await setPreference(key, value, database);
    return { ok: true };
  }
  const service = database ? createPreferenceService({ database }) : preferenceService;
  const { applied, divergence } = await service.updateSettings({ [key]: value });
  if (divergence) return { ok: false, error: formatDivergence(key, value, divergence) };
  if (!applied.includes(key)) {
    return { ok: false, error: `Key '${key}' was rejected by the settings whitelist (nothing written).` };
  }
  return { ok: true };
}

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
    .description("Set a preference value. Provider/profile keys are checked against the active project's Strategy Bullseye (#903).")
    .action(async (key: string, value: string) => {
      try {
        await runMigrations();
        const result = await setPreferenceGuarded(key, value);
        if (!result.ok) {
          console.error("Error:", result.error);
          process.exit(1);
        }
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
