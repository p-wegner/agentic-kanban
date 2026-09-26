import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLUGIN_SKILL_LISTING,
  isHiddenFromModel,
  mergePluginSkillOverrides,
  parsePluginSkillListingOverrides,
  pluginSkillListingPreferenceKey,
  resolvePluginSkillListing,
} from "../src/lib/plugin-skill-listing.js";
import { isPluginSkillListingPreferenceKey, isProjectScopedDynamicKey } from "../src/lib/dynamic-preference-keys.js";
import { parsePluginManifest } from "../src/lib/plugin-manifest.js";

// #1251: a plugin skill's listing to the model is the board's decision, never its SKILL.md's.

const PROJECT = "d1c5d9c1-4897-4e1b-acc3-2aa96de04117";

describe("resolvePluginSkillListing — precedence", () => {
  it("defaults to name-only, so an enabled plugin adds no descriptions to context", () => {
    expect(DEFAULT_PLUGIN_SKILL_LISTING).toBe("name-only");
    expect(resolvePluginSkillListing({ skillName: "x" })).toBe("name-only");
  });

  it("board-wide default < manifest hint < project override", () => {
    expect(resolvePluginSkillListing({ skillName: "x", globalDefault: "off" })).toBe("off");
    expect(resolvePluginSkillListing({ skillName: "x", globalDefault: "off", manifestListing: "on" })).toBe("on");
    expect(
      resolvePluginSkillListing({
        skillName: "x",
        globalDefault: "off",
        manifestListing: "on",
        projectOverrides: { x: "user-invocable-only" },
      }),
    ).toBe("user-invocable-only");
  });

  it("an override for another skill does not leak, and an unknown global default is ignored", () => {
    expect(resolvePluginSkillListing({ skillName: "x", projectOverrides: { y: "on" }, globalDefault: "bogus" })).toBe(
      "name-only",
    );
  });
});

describe("parsePluginSkillListingOverrides", () => {
  it("keeps valid entries and names the invalid ones instead of dropping the map", () => {
    const { overrides, invalid } = parsePluginSkillListingOverrides(JSON.stringify({ a: "on", b: "loud", c: "off" }));
    expect(overrides).toEqual({ a: "on", c: "off" });
    expect(invalid).toEqual(["b"]);
  });

  it("reports unparseable and non-object values, and treats absent as empty", () => {
    expect(parsePluginSkillListingOverrides("{nope").invalid).toEqual(["<unparseable JSON>"]);
    expect(parsePluginSkillListingOverrides("[1]").invalid).toEqual(["<not a JSON object>"]);
    expect(parsePluginSkillListingOverrides(null)).toEqual({ overrides: {}, invalid: [] });
  });
});

describe("mergePluginSkillOverrides — the board owns only its managed names", () => {
  it("sets managed names, removes managed names no longer desired, and keeps everything else", () => {
    const before = {
      permissions: { allow: ["Bash(ls)"] },
      skillOverrides: { "hand-written": "off", "gone-plugin-skill": "name-only" },
    };
    const { settings, changed } = mergePluginSkillOverrides(
      before,
      { "plugin-skill": "name-only" },
      ["plugin-skill", "gone-plugin-skill"],
    );
    expect(changed).toBe(true);
    expect(settings).toEqual({
      permissions: { allow: ["Bash(ls)"] },
      skillOverrides: { "hand-written": "off", "plugin-skill": "name-only" },
    });
  });

  it("reports no change when the file already says what the board wants", () => {
    const { changed } = mergePluginSkillOverrides({ skillOverrides: { a: "on" } }, { a: "on" }, ["a"]);
    expect(changed).toBe(false);
  });

  it("drops an emptied skillOverrides key rather than leaving {}", () => {
    const { settings, changed } = mergePluginSkillOverrides({ skillOverrides: { a: "on" }, x: 1 }, {}, ["a"]);
    expect(changed).toBe(true);
    expect(settings).toEqual({ x: 1 });
  });
});

describe("keys and manifest field", () => {
  it("the per-project override key is an allowed dynamic preference key", () => {
    const key = pluginSkillListingPreferenceKey("refactor-safety-net", PROJECT);
    expect(key).toBe(`plugin_skill_listing_refactor-safety-net_${PROJECT}`);
    expect(isPluginSkillListingPreferenceKey(key)).toBe(true);
    expect(isProjectScopedDynamicKey(key)).toBe(true);
  });

  it("isHiddenFromModel is true only for the two listings that remove the skill from the model", () => {
    expect(["on", "name-only", "user-invocable-only", "off"].map((l) => isHiddenFromModel(l as never))).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  it("the manifest accepts a skills[].listing hint and rejects an unknown one", () => {
    const base = { id: "p", name: "P" };
    const ok = parsePluginManifest(JSON.stringify({ ...base, skills: [{ dir: "s/a", listing: "on" }] }));
    expect(ok.skills?.[0].listing).toBe("on");
    expect(() => parsePluginManifest(JSON.stringify({ ...base, skills: [{ dir: "s/a", listing: "loud" }] }))).toThrow(
      /listing/,
    );
  });
});
