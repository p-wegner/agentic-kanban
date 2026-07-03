import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { prodDeps, type ToolDeps } from "./deps.js";
import { SETTINGS_REGISTRY_KEYS } from "@agentic-kanban/shared/lib/settings-registry";
import {
  isProjectScopedDynamicKey,
  isBoardStrategyPreferenceKey,
  PROJECT_SCOPED_KEY_PREFIXES,
  START_MODE_VALUES,
} from "@agentic-kanban/shared/lib/dynamic-preference-keys";

const STATIC_KEYS: ReadonlySet<string> = new Set<string>(SETTINGS_REGISTRY_KEYS);

// Per-harness keys (`harness.<harness>.plan_auto_continue`). The server route
// whitelists these via `allHarnessSettingKeys()` (server-only — it lives next to the
// harness defaults); this mirrors the same shape. Keep in sync with
// `HarnessSettingKeyName` in @agentic-kanban/shared/lib/settings-registry.
const HARNESS_KEY_PATTERN = /^harness\.(claude|codex|copilot|pi)\.plan_auto_continue$/;

/**
 * Mirror of the settings route's write allow-list (#989): static registry keys +
 * per-harness keys + per-project dynamic keys + the board-strategy JSON key.
 * `set_preference` used to upsert ANY key/value unchecked, so a typo'd
 * `start_mode_<id>` key (or a case-wrong value) was silently accepted and
 * `resolveStartPolicy` silently fell back — the `manual` kill-switch could be
 * silently ineffective.
 */
function isAllowedKey(key: string): boolean {
  return (
    STATIC_KEYS.has(key) ||
    HARNESS_KEY_PATTERN.test(key) ||
    isProjectScopedDynamicKey(key) ||
    isBoardStrategyPreferenceKey(key)
  );
}

/** Returns an error message for a value the key's registry constrains, else null. */
function validateValue(key: string, value: string): string | null {
  // start_mode_<projectId> is enum-valued; resolveStartPolicy silently ignores any
  // other value (case-sensitively), so reject rather than coerce.
  if (key.startsWith("start_mode_")) {
    if (!(START_MODE_VALUES as readonly string[]).includes(value)) {
      return `Invalid value "${value}" for "${key}": must be exactly one of ${START_MODE_VALUES.join(" | ")} (case-sensitive — resolveStartPolicy silently falls back on anything else). Nothing was written.`;
    }
  }
  // board_strategy_<projectId> stays a JSON passthrough — no value validation here.
  return null;
}

const SET_PREFERENCE_DESCRIPTION =
  "Set (upsert) a preference value by key. Mirrors CLI `preferences set <key> <value>`. Validates like the settings route: unknown keys are rejected (allowed: static settings-registry keys, harness.<harness>.plan_auto_continue, per-project dynamic keys like start_mode_<projectId>, and board_strategy_<projectId>), and start_mode_* values must be exactly manual|monitor|conductor. Use get_preference to read it back.";

export function registerSetPreference(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;
  server.tool(
    "set_preference",
    SET_PREFERENCE_DESCRIPTION,
    {
      key: z.string().describe("The preference key to set (e.g. 'projects_base_path', 'auto_merge', 'claude_profile', 'start_mode_<projectId>')"),
      value: z.string().describe("The value to store for this preference key"),
    },
    async ({ key, value }) => {
      if (!isAllowedKey(key)) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                key,
                error:
                  `Unknown preference key "${key}" — nothing was written. Valid keys are: ` +
                  `static settings keys (SETTINGS_REGISTRY in @agentic-kanban/shared/lib/settings-registry), ` +
                  `per-harness keys (harness.<claude|codex|copilot|pi>.plan_auto_continue), ` +
                  `per-project dynamic keys "<prefix>_<projectId>" with prefix in [${PROJECT_SCOPED_KEY_PREFIXES.join(", ")}] ` +
                  `(see @agentic-kanban/shared/lib/dynamic-preference-keys), or board_strategy_<projectId>. ` +
                  `Check the key for typos (e.g. a truncated project id suffix).`,
              }),
            },
          ],
        };
      }

      const valueError = validateValue(key, value);
      if (valueError) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, key, value, error: valueError }) }],
        };
      }

      const now = new Date().toISOString();
      await db
        .insert(schema.preferences)
        .values({ key, value, updatedAt: now })
        .onConflictDoUpdate({ target: schema.preferences.key, set: { value, updatedAt: now } });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ key, value, updatedAt: now, ok: true }),
          },
        ],
      };
    },
  );
}
