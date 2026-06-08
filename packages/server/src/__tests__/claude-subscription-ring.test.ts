import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  parseClaudeSubscriptionRing,
  findRingEntry,
  ringProfileNames,
  pickNextSubscription,
  cooldownKey,
  cooldownUntilIso,
  defaultClaudeConfigDir,
  resolveClaudeConfigDir,
  resolveClaudeConfigDirForProfile,
} from "../services/claude-subscription-ring.js";

const RING = JSON.stringify([
  { profile: "max1", configDir: "C:\\Users\\x\\.claude-max1" },
  { profile: "max2", configDir: "C:\\Users\\x\\.claude-max2" },
  { profile: "apikey1", settingsProfile: "apikey1" },
]);

describe("parseClaudeSubscriptionRing", () => {
  it("parses a well-formed ring", () => {
    const ring = parseClaudeSubscriptionRing(RING);
    expect(ring).toHaveLength(3);
    expect(ring[0]).toEqual({ profile: "max1", configDir: "C:\\Users\\x\\.claude-max1", settingsProfile: undefined });
    expect(ring[2].settingsProfile).toBe("apikey1");
  });

  it("returns [] for empty/garbage/non-array input", () => {
    expect(parseClaudeSubscriptionRing(undefined)).toEqual([]);
    expect(parseClaudeSubscriptionRing("")).toEqual([]);
    expect(parseClaudeSubscriptionRing("not json")).toEqual([]);
    expect(parseClaudeSubscriptionRing(JSON.stringify({ profile: "x" }))).toEqual([]);
  });

  it("drops entries without a profile name", () => {
    const ring = parseClaudeSubscriptionRing(JSON.stringify([{ configDir: "x" }, { profile: "ok" }]));
    expect(ring.map((e) => e.profile)).toEqual(["ok"]);
  });
});

describe("findRingEntry / ringProfileNames", () => {
  const ring = parseClaudeSubscriptionRing(RING);
  it("finds a subscription by profile name", () => {
    expect(findRingEntry(ring, "max2")?.configDir).toBe("C:\\Users\\x\\.claude-max2");
  });
  it("treats 'default'/empty as no ring entry", () => {
    expect(findRingEntry(ring, "default")).toBeUndefined();
    expect(findRingEntry(ring, undefined)).toBeUndefined();
  });
  it("lists profile names for the dropdown", () => {
    expect(ringProfileNames(ring)).toEqual(["max1", "max2", "apikey1"]);
  });
});

describe("defaultClaudeConfigDir / resolveClaudeConfigDir", () => {
  it("infers ~/.claude-<profile> for the default config dir", () => {
    expect(defaultClaudeConfigDir("max1")).toBe(join(homedir(), ".claude-max1"));
  });

  it("resolves an explicit configDir override", () => {
    expect(resolveClaudeConfigDir({ profile: "max1", configDir: "C:\\custom\\dir" })).toBe("C:\\custom\\dir");
  });

  it("falls back to the inferred default when configDir is absent (OAuth subscription)", () => {
    expect(resolveClaudeConfigDir({ profile: "max2" })).toBe(join(homedir(), ".claude-max2"));
  });

  it("returns undefined for an API-key (settings profile) subscription", () => {
    expect(resolveClaudeConfigDir({ profile: "apikey1", settingsProfile: "apikey1" })).toBeUndefined();
  });
});

describe("resolveClaudeConfigDirForProfile", () => {
  const ring = parseClaudeSubscriptionRing(RING);

  it("resolves an explicit ring entry's configDir", () => {
    expect(resolveClaudeConfigDirForProfile("max2", ring)).toBe("C:\\Users\\x\\.claude-max2");
  });

  it("returns undefined for an API-key ring entry (uses --settings, no config dir)", () => {
    expect(resolveClaudeConfigDirForProfile("apikey1", ring)).toBeUndefined();
  });

  it("returns undefined for default / mock / empty", () => {
    expect(resolveClaudeConfigDirForProfile("default", ring)).toBeUndefined();
    expect(resolveClaudeConfigDirForProfile("mock", ring)).toBeUndefined();
    expect(resolveClaudeConfigDirForProfile(undefined, ring)).toBeUndefined();
  });

  it("returns undefined for a profile with neither a ring entry nor a ~/.claude-<name> dir", () => {
    expect(resolveClaudeConfigDirForProfile("nope-no-such-subscription", [])).toBeUndefined();
  });
});

describe("pickNextSubscription", () => {
  const ring = parseClaudeSubscriptionRing(RING);
  const now = new Date("2026-06-07T12:00:00Z");

  it("rotates to the next entry in ring order, wrapping", () => {
    expect(pickNextSubscription(ring, "max1", new Map(), now)?.profile).toBe("max2");
    expect(pickNextSubscription(ring, "apikey1", new Map(), now)?.profile).toBe("max1");
  });

  it("skips a subscription whose cooldown has not elapsed", () => {
    const prefs = new Map([[cooldownKey("max2"), "2026-06-07T18:00:00Z"]]);
    expect(pickNextSubscription(ring, "max1", prefs, now)?.profile).toBe("apikey1");
  });

  it("treats an elapsed cooldown as available", () => {
    const prefs = new Map([[cooldownKey("max2"), "2026-06-07T06:00:00Z"]]);
    expect(pickNextSubscription(ring, "max1", prefs, now)?.profile).toBe("max2");
  });

  it("returns undefined when all others are cooled", () => {
    const prefs = new Map([
      [cooldownKey("max2"), "2026-06-07T18:00:00Z"],
      [cooldownKey("apikey1"), "2026-06-07T18:00:00Z"],
    ]);
    expect(pickNextSubscription(ring, "max1", prefs, now)).toBeUndefined();
  });

  it("returns undefined for an empty ring", () => {
    expect(pickNextSubscription([], "max1", new Map(), now)).toBeUndefined();
  });
});

describe("cooldownUntilIso", () => {
  const now = new Date("2026-06-07T12:00:00Z");
  it("uses a parseable future ISO resetsAt", () => {
    expect(cooldownUntilIso("2026-06-07T17:00:00Z", now)).toBe("2026-06-07T17:00:00.000Z");
  });
  it("uses a unix epoch-seconds resetsAt (Claude rate_limit_event shape)", () => {
    const epochSeconds = Math.floor(new Date("2026-06-07T17:00:00Z").getTime() / 1000);
    expect(cooldownUntilIso(epochSeconds, now)).toBe("2026-06-07T17:00:00.000Z");
  });
  it("falls back to now + 5h for missing/garbage/past resetsAt", () => {
    expect(cooldownUntilIso(null, now)).toBe("2026-06-07T17:00:00.000Z");
    expect(cooldownUntilIso("at 3pm tomorrow", now)).toBe("2026-06-07T17:00:00.000Z");
    expect(cooldownUntilIso("2026-06-07T06:00:00Z", now)).toBe("2026-06-07T17:00:00.000Z");
  });
});
