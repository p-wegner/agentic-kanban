import type { ProviderName } from "./agent-provider/types.js";

/**
 * Per-harness behavior settings — knobs that mean different things (or apply at all)
 * depending on which agent harness is driving the workspace. Persisted as flat
 * preference rows keyed by `harness.<harness>.<setting>`.
 *
 * The legacy flat key (e.g. `plan_auto_continue`) is consulted as a fallback so
 * existing installations keep their previous toggle until the user re-saves.
 */

export const HARNESS_IDS: readonly ProviderName[] = ["claude", "codex", "copilot"] as const;

export type HarnessSettingKey = "plan_auto_continue";

interface HarnessSettingDef {
  /** Legacy global preference key consulted as a fallback. */
  legacyKey?: string;
  /** Default per harness when neither the harness-scoped nor legacy key is set. */
  defaults: Partial<Record<ProviderName, boolean>>;
  /** Default applied when no per-harness default is listed. */
  fallbackDefault: boolean;
}

const DEFS: Record<HarnessSettingKey, HarnessSettingDef> = {
  plan_auto_continue: {
    legacyKey: "plan_auto_continue",
    defaults: { codex: true, copilot: true, claude: true },
    fallbackDefault: true,
  },
};

export function harnessSettingKey(harness: ProviderName, setting: HarnessSettingKey): string {
  return `harness.${harness}.${setting}`;
}

/** All preference keys this module owns — for whitelisting in preferences route/service. */
export function allHarnessSettingKeys(): string[] {
  const keys: string[] = [];
  for (const setting of Object.keys(DEFS) as HarnessSettingKey[]) {
    for (const harness of HARNESS_IDS) keys.push(harnessSettingKey(harness, setting));
  }
  return keys;
}

/** Read a per-harness boolean setting from a preference map, with legacy + default fallback. */
export function getHarnessBoolSetting(
  prefs: Map<string, string> | Record<string, string>,
  harness: ProviderName,
  setting: HarnessSettingKey,
): boolean {
  const def = DEFS[setting];
  const get = (k: string): string | undefined =>
    prefs instanceof Map ? prefs.get(k) : prefs[k];

  const scoped = get(harnessSettingKey(harness, setting));
  if (scoped !== undefined && scoped !== "") return scoped !== "false";

  if (def.legacyKey) {
    const legacy = get(def.legacyKey);
    if (legacy !== undefined && legacy !== "") return legacy !== "false";
  }

  return def.defaults[harness] ?? def.fallbackDefault;
}
