/**
 * How a PLUGIN skill is listed to the model (#1251).
 *
 * A plugin's skills are junctioned into `.claude/skills` on enable and copied into every
 * worktree, so each one's `description` loads into every session of the project — builders
 * included — whether or not it ever fires. Measured 2026-09-26 on this repo: 14 plugin skills,
 * ≈11k description characters (≈2.8k tokens) per session. The skills' own repos must stay
 * self-contained and model-invocable, so the lever cannot be their frontmatter: the board owns
 * it, as Claude Code's `skillOverrides` setting written next to the skills it materialized.
 *
 * Vocabulary is Claude Code's own (2.1.282): `on` lists name + description, `name-only` lists the
 * name without its description (still model-invocable), `user-invocable-only` hides it from the
 * model but keeps `/name`, `off` hides it from both.
 *
 * Precedence, strongest first: the project override (`plugin_skill_listing_<slug>_<projectId>`, a
 * JSON map skill→listing) → the plugin manifest's `skills[].listing` hint → the board-wide
 * `plugin_skill_listing_default` → `name-only`. The default is deliberately not `on`: a plugin
 * must not grow every session's context unless someone chose that.
 *
 * Pure strings, no Node builtins — client-safe through the shared lib barrel.
 */

export const SKILL_LISTINGS = ["on", "name-only", "user-invocable-only", "off"] as const;
export type SkillListing = (typeof SKILL_LISTINGS)[number];

/** The listing a plugin skill gets when nothing anywhere says otherwise. */
export const DEFAULT_PLUGIN_SKILL_LISTING: SkillListing = "name-only";

/** Board-wide default listing for plugin skills (registered in SETTINGS_REGISTRY). */
export const PLUGIN_SKILL_LISTING_DEFAULT_KEY = "plugin_skill_listing_default";

export function isSkillListing(value: unknown): value is SkillListing {
  return typeof value === "string" && (SKILL_LISTINGS as readonly string[]).includes(value);
}

/** Per-project override key: `plugin_skill_listing_<pluginSlug>_<projectId>`, value a JSON map. */
export function pluginSkillListingPreferenceKey(pluginSlug: string, projectId: string): string {
  return `plugin_skill_listing_${pluginSlug}_${projectId}`;
}

/**
 * Parse a project override value. Entries that are not a known listing are DROPPED and named in
 * `invalid`, so one typo neither hides the rest nor silently becomes a listing nobody chose.
 */
export function parsePluginSkillListingOverrides(raw: string | null | undefined): {
  overrides: Record<string, SkillListing>;
  invalid: string[];
} {
  const overrides: Record<string, SkillListing> = {};
  const invalid: string[] = [];
  if (raw == null || raw.trim() === "") return { overrides, invalid };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { overrides, invalid: ["<unparseable JSON>"] };
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { overrides, invalid: ["<not a JSON object>"] };
  }
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isSkillListing(value)) overrides[name] = value;
    else invalid.push(name);
  }
  return { overrides, invalid };
}

/** Resolve one skill's listing. See the module comment for the precedence. */
export function resolvePluginSkillListing(input: {
  skillName: string;
  projectOverrides?: Record<string, SkillListing>;
  manifestListing?: SkillListing;
  globalDefault?: string | null;
}): SkillListing {
  const fromProject = input.projectOverrides?.[input.skillName];
  if (fromProject) return fromProject;
  if (input.manifestListing) return input.manifestListing;
  if (isSkillListing(input.globalDefault)) return input.globalDefault;
  return DEFAULT_PLUGIN_SKILL_LISTING;
}

/** True when the model must not see the skill at all — what a provider without a listing mode honours. */
export function isHiddenFromModel(listing: SkillListing | undefined): boolean {
  return listing === "user-invocable-only" || listing === "off";
}

/**
 * Merge the board's plugin-skill listings into a parsed Claude Code settings object.
 *
 * The board owns ONLY the names in `managed` (every plugin skill it could have written): each is
 * set to its `desired` listing, or removed when absent from `desired` (a disabled plugin). Every
 * other `skillOverrides` key — a hand-written override — and every other setting survive
 * untouched. Returns the new object and whether anything changed, so an unchanged file is not
 * rewritten.
 */
export function mergePluginSkillOverrides(
  settings: Record<string, unknown>,
  desired: Record<string, SkillListing>,
  managed: Iterable<string>,
): { settings: Record<string, unknown>; changed: boolean } {
  const current =
    settings.skillOverrides && typeof settings.skillOverrides === "object" && !Array.isArray(settings.skillOverrides)
      ? { ...(settings.skillOverrides as Record<string, unknown>) }
      : {};
  let changed = false;
  for (const name of managed) {
    const want = desired[name];
    if (want === undefined) {
      if (name in current) {
        delete current[name];
        changed = true;
      }
    } else if (current[name] !== want) {
      current[name] = want;
      changed = true;
    }
  }
  const next: Record<string, unknown> = { ...settings };
  if (Object.keys(current).length > 0) next.skillOverrides = current;
  // Emptied by this merge (already `changed`) or empty before it (cosmetic): drop the key either way.
  else delete next.skillOverrides;
  return { settings: next, changed };
}
