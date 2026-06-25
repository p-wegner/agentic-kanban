import { describe, it, expect } from "vitest";
import {
  SETTINGS_REGISTRY,
  SETTINGS_REGISTRY_KEYS,
  DEFAULT_SETTINGS,
  getBool,
  getNumber,
  getJson,
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
  it("getBool reads from Map and Record, with the 'false' rule", () => {
    expect(getBool(new Map([["k", "true"]]), "k")).toBe(true);
    expect(getBool(new Map([["k", "false"]]), "k")).toBe(false);
    expect(getBool({ k: "anything" }, "k")).toBe(true); // present, not "false" => true
    expect(getBool({}, "k")).toBe(false); // absent => fallback
    expect(getBool({}, "k", true)).toBe(true);
    expect(getBool({ k: "" }, "k", true)).toBe(true); // empty => fallback
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
