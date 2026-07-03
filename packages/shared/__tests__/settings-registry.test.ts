import { describe, it, expect } from "vitest";
import {
  SETTINGS_REGISTRY,
  SETTINGS_REGISTRY_KEYS,
  DEFAULT_SETTINGS,
  getBool,
  getNumber,
  getJson,
  parseBoolSetting,
} from "../src/lib/settings-registry.js";

describe("settings registry derivations", () => {
  it("SETTINGS_REGISTRY_KEYS matches the registry's own keys", () => {
    expect(new Set(SETTINGS_REGISTRY_KEYS)).toEqual(new Set(Object.keys(SETTINGS_REGISTRY)));
  });

  it("DEFAULT_SETTINGS = registry entries with a non-empty default", () => {
    const expected = Object.fromEntries(
      Object.entries(SETTINGS_REGISTRY).filter(([, d]) => d.default !== "").map(([k, d]) => [k, d.default]),
    );
    expect(DEFAULT_SETTINGS).toEqual(expected);
  });

  it("every registry entry declares a known type", () => {
    for (const def of Object.values(SETTINGS_REGISTRY)) {
      expect(["string", "bool", "number", "json"]).toContain(def.type);
    }
  });
});

describe("typed accessors", () => {
  it("getBool reads from Map and Record; non-registry keys follow the fallback's polarity", () => {
    expect(getBool(new Map([["k", "true"]]), "k")).toBe(true);
    expect(getBool(new Map([["k", "false"]]), "k")).toBe(false);
    expect(getBool({}, "k")).toBe(false); // absent => fallback
    expect(getBool({}, "k", true)).toBe(true);
    expect(getBool({ k: "" }, "k", true)).toBe(true); // empty => fallback
    // Set-value semantics follow the effective default's polarity family (#947):
    expect(getBool({ k: "anything" }, "k", true)).toBe(true); // default-ON: !== "false"
    expect(getBool({ k: "anything" }, "k", false)).toBe(false); // default-OFF: === "true"
  });

  it("getBool honors the per-key registry default when the key is unset (#947)", () => {
    // Default-ON registry keys (default: "true") — fallback param is ignored.
    expect(getBool(new Map(), "auto_review")).toBe(true);
    expect(getBool(new Map(), "review_auto_fix")).toBe(true);
    expect(getBool(new Map(), "skip_permissions")).toBe(true);
    expect(getBool({}, "review_auto_fix", false)).toBe(true); // registry wins over fallback
    // Default-OFF registry keys (default: "false").
    expect(getBool(new Map(), "auto_monitor")).toBe(false);
    expect(getBool(new Map(), "auto_merge_in_review")).toBe(false);
    expect(getBool({}, "auto_monitor", true)).toBe(false); // registry wins over fallback
    // Explicit values always win.
    expect(getBool(new Map([["review_auto_fix", "false"]]), "review_auto_fix")).toBe(false);
    expect(getBool(new Map([["auto_monitor", "true"]]), "auto_monitor")).toBe(true);
    // Registry bool key with an EMPTY default falls back to the param.
    expect(getBool(new Map(), "export_skills_on_registration")).toBe(false);
    expect(getBool(new Map(), "export_skills_on_registration", true)).toBe(true);
  });

  it("parseBoolSetting parses a raw value directly (getPreference-style callers)", () => {
    expect(parseBoolSetting("monitor_butler_enabled", null)).toBe(false);
    expect(parseBoolSetting("monitor_butler_enabled", "true")).toBe(true);
    expect(parseBoolSetting("review_auto_fix", undefined)).toBe(true);
    expect(parseBoolSetting("review_auto_fix", "false")).toBe(false);
    // Default-ON keys keep the canonical "anything but 'false' is on" semantics.
    expect(parseBoolSetting("review_auto_fix", "1")).toBe(true);
    // Default-OFF keys require the literal "true".
    expect(parseBoolSetting("auto_monitor", "1")).toBe(false);
  });

  it("getNumber parses, falling back on absent/unparseable", () => {
    expect(getNumber(new Map([["k", "42"]]), "k")).toBe(42);
    expect(getNumber({ k: "3.5" }, "k")).toBe(3.5);
    expect(getNumber({ k: "nope" }, "k", 7)).toBe(7);
    expect(getNumber({}, "k", 7)).toBe(7);
    expect(getNumber({ k: "" }, "k", 7)).toBe(7);
  });

  it("getJson parses, falling back on absent/invalid", () => {
    expect(getJson(new Map([["k", '{"a":1}']]), "k", {})).toEqual({ a: 1 });
    expect(getJson({ k: "[1,2]" }, "k", [])).toEqual([1, 2]);
    expect(getJson({ k: "{bad" }, "k", { fallback: true })).toEqual({ fallback: true });
    expect(getJson({}, "k", null)).toBeNull();
  });
});
