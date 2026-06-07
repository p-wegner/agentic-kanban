import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  parseCodexLicenseRing,
  findRingEntry,
  ringProfileNames,
  pickNextLicense,
  cooldownKey,
  cooldownUntilIso,
  defaultCodexHome,
  resolveCodexHome,
  resolveCodexHomeForProfile,
} from "../services/codex-license-ring.js";

const RING = JSON.stringify([
  { profile: "ki14", codexHome: "C:\\Users\\x\\.codex-ki14" },
  { profile: "ki15", codexHome: "C:\\Users\\x\\.codex-ki15" },
  { profile: "apikey1", configToml: "config_apikey1" },
]);

describe("parseCodexLicenseRing", () => {
  it("parses a well-formed ring", () => {
    const ring = parseCodexLicenseRing(RING);
    expect(ring).toHaveLength(3);
    expect(ring[0]).toEqual({ profile: "ki14", codexHome: "C:\\Users\\x\\.codex-ki14", configToml: undefined });
    expect(ring[2].configToml).toBe("config_apikey1");
  });

  it("returns [] for empty/garbage/non-array input", () => {
    expect(parseCodexLicenseRing(undefined)).toEqual([]);
    expect(parseCodexLicenseRing("")).toEqual([]);
    expect(parseCodexLicenseRing("not json")).toEqual([]);
    expect(parseCodexLicenseRing(JSON.stringify({ profile: "x" }))).toEqual([]);
  });

  it("drops entries without a profile name", () => {
    const ring = parseCodexLicenseRing(JSON.stringify([{ codexHome: "x" }, { profile: "ok" }]));
    expect(ring.map((e) => e.profile)).toEqual(["ok"]);
  });
});

describe("findRingEntry / ringProfileNames", () => {
  const ring = parseCodexLicenseRing(RING);
  it("finds a license by profile name", () => {
    expect(findRingEntry(ring, "ki15")?.codexHome).toBe("C:\\Users\\x\\.codex-ki15");
  });
  it("treats 'default'/empty as no ring entry", () => {
    expect(findRingEntry(ring, "default")).toBeUndefined();
    expect(findRingEntry(ring, undefined)).toBeUndefined();
  });
  it("lists profile names for the dropdown", () => {
    expect(ringProfileNames(ring)).toEqual(["ki14", "ki15", "apikey1"]);
  });
});

describe("defaultCodexHome / resolveCodexHome", () => {
  it("infers ~/.codex-<profile> for the default home", () => {
    expect(defaultCodexHome("ki14")).toBe(join(homedir(), ".codex-ki14"));
  });

  it("resolves an explicit codexHome override", () => {
    expect(resolveCodexHome({ profile: "ki14", codexHome: "C:\\custom\\dir" })).toBe("C:\\custom\\dir");
  });

  it("falls back to the inferred default when codexHome is absent (OAuth license)", () => {
    expect(resolveCodexHome({ profile: "ki15" })).toBe(join(homedir(), ".codex-ki15"));
  });

  it("returns undefined for an API-key (config toml) license", () => {
    expect(resolveCodexHome({ profile: "apikey1", configToml: "config_apikey1" })).toBeUndefined();
  });
});

describe("resolveCodexHomeForProfile", () => {
  const ring = parseCodexLicenseRing(RING);

  it("resolves an explicit ring entry's codexHome", () => {
    expect(resolveCodexHomeForProfile("ki15", ring)).toBe("C:\\Users\\x\\.codex-ki15");
  });

  it("returns undefined for an API-key ring entry (uses --profile, no home)", () => {
    expect(resolveCodexHomeForProfile("apikey1", ring)).toBeUndefined();
  });

  it("returns undefined for default / empty", () => {
    expect(resolveCodexHomeForProfile("default", ring)).toBeUndefined();
    expect(resolveCodexHomeForProfile(undefined, ring)).toBeUndefined();
  });

  it("returns undefined for a profile with neither a ring entry nor a ~/.codex-<name> dir", () => {
    // 'nope' has no ring entry; ~/.codex-nope almost certainly does not exist on this host.
    expect(resolveCodexHomeForProfile("nope-no-such-license", [])).toBeUndefined();
  });
});

describe("pickNextLicense", () => {
  const ring = parseCodexLicenseRing(RING);
  const now = new Date("2026-06-07T12:00:00Z");

  it("rotates to the next entry in ring order, wrapping", () => {
    expect(pickNextLicense(ring, "ki14", new Map(), now)?.profile).toBe("ki15");
    expect(pickNextLicense(ring, "apikey1", new Map(), now)?.profile).toBe("ki14");
  });

  it("skips a license whose cooldown has not elapsed", () => {
    const prefs = new Map([[cooldownKey("ki15"), "2026-06-07T18:00:00Z"]]);
    expect(pickNextLicense(ring, "ki14", prefs, now)?.profile).toBe("apikey1");
  });

  it("treats an elapsed cooldown as available", () => {
    const prefs = new Map([[cooldownKey("ki15"), "2026-06-07T06:00:00Z"]]);
    expect(pickNextLicense(ring, "ki14", prefs, now)?.profile).toBe("ki15");
  });

  it("returns undefined when all others are cooled", () => {
    const prefs = new Map([
      [cooldownKey("ki15"), "2026-06-07T18:00:00Z"],
      [cooldownKey("apikey1"), "2026-06-07T18:00:00Z"],
    ]);
    expect(pickNextLicense(ring, "ki14", prefs, now)).toBeUndefined();
  });

  it("returns undefined for an empty ring", () => {
    expect(pickNextLicense([], "ki14", new Map(), now)).toBeUndefined();
  });
});

describe("cooldownUntilIso", () => {
  const now = new Date("2026-06-07T12:00:00Z");
  it("uses a parseable future retryAfter", () => {
    expect(cooldownUntilIso("2026-06-07T17:00:00Z", now)).toBe("2026-06-07T17:00:00.000Z");
  });
  it("falls back to now + 3h for missing/garbage/past retryAfter", () => {
    expect(cooldownUntilIso(null, now)).toBe("2026-06-07T15:00:00.000Z");
    expect(cooldownUntilIso("at 3pm tomorrow", now)).toBe("2026-06-07T15:00:00.000Z");
    expect(cooldownUntilIso("2026-06-07T06:00:00Z", now)).toBe("2026-06-07T15:00:00.000Z");
  });
});
