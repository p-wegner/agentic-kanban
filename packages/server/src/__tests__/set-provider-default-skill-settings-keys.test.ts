// @gate:always-run — scans skill markdown for a write to the retired global default_model key.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS_KEYS } from "../services/preference.service.js";

/**
 * #929: the set-provider-default skill unconditionally wrote patch["default_model"], a key
 * retired by #902 in favor of provider-scoped default_model_<provider>. SETTINGS_KEYS then
 * rejected the whole PUT (422) even though the other keys were applied, so the skill's own
 * verify step reported ok:false for a write that had actually succeeded.
 *
 * This guard makes sure the skill (both the .claude and .codex copies) never again emits a
 * key that PUT /api/preferences/settings would reject.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const SKILL_PATHS = [
  join(REPO_ROOT, ".claude", "skills", "set-provider-default", "SKILL.md"),
  join(REPO_ROOT, ".codex", "skills", "set-provider-default", "SKILL.md"),
];

describe("#929 — set-provider-default skill only writes whitelisted setting keys", () => {
  it("the retired global default_model key is never assigned in the skill's PUT payload", () => {
    for (const path of SKILL_PATHS) {
      const content = readFileSync(path, "utf8");
      expect(content).not.toMatch(/patch\["default_model"\]/);
    }
  });

  it("every settings key referenced as a patch[...] assignment is on SETTINGS_KEYS", () => {
    for (const path of SKILL_PATHS) {
      const content = readFileSync(path, "utf8");
      const matches = [...content.matchAll(/patch\["([a-z_]+)"\]\s*=/g)].map((m) => m[1]);
      expect(matches.length).toBeGreaterThan(0);
      for (const key of matches) {
        expect(SETTINGS_KEYS.includes(key)).toBe(true);
      }
    }
  });
});
