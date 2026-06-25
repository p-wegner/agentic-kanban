import { describe, it, expect } from "vitest";
import { SETTINGS_KEYS } from "../services/preference.service.js";
import {
  SETTINGS_REGISTRY,
  SETTINGS_REGISTRY_KEYS,
  DEFAULT_SETTINGS,
} from "@agentic-kanban/shared/lib/settings-registry";
import { allHarnessSettingKeys } from "../services/harness-settings.js";

/**
 * GATE for #903 — the typed settings registry is the SINGLE SOURCE OF TRUTH. The
 * server whitelist (`SETTINGS_KEYS`) MUST equal the registry keys plus the dynamic
 * per-harness keys, with no drift in either direction. A new key added to the
 * registry (or accidentally dropped from the derived whitelist) is caught here.
 */
describe("SETTINGS_KEYS is derived from the settings registry", () => {
  it("equals the registry keys + harness keys, exactly (set equality)", () => {
    const expected = new Set([...SETTINGS_REGISTRY_KEYS, ...allHarnessSettingKeys()]);
    const actual = new Set(SETTINGS_KEYS);
    // No registry/harness key missing from the whitelist.
    for (const key of expected) expect(actual.has(key)).toBe(true);
    // No extra whitelist key that isn't in the registry/harness set.
    for (const key of actual) expect(expected.has(key)).toBe(true);
    expect(actual.size).toBe(expected.size);
  });

  it("has no duplicate keys in the derived whitelist", () => {
    expect(new Set(SETTINGS_KEYS).size).toBe(SETTINGS_KEYS.length);
  });

  it("DEFAULT_SETTINGS only carries registry keys with a non-empty default", () => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      expect(SETTINGS_REGISTRY_KEYS).toContain(key);
      const def = SETTINGS_REGISTRY[key as keyof typeof SETTINGS_REGISTRY];
      expect(def.default).toBe(value);
      expect(def.default).not.toBe("");
    }
    // Every non-empty-default registry entry is present in DEFAULT_SETTINGS.
    for (const [key, def] of Object.entries(SETTINGS_REGISTRY)) {
      if (def.default !== "") expect(DEFAULT_SETTINGS[key as keyof typeof DEFAULT_SETTINGS]).toBe(def.default);
    }
  });
});
