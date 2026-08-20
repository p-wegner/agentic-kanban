// @covers agents.services.authRotationRing
// @covers agents.services.strategyPolicyMutation
//
// #648 item 4: `auth-rotation-ring.ts` was imported by exactly one test — a pref-key
// POLARITY ratchet, which asserts nothing about rotation behaviour — and
// `strategy-policy-mutation.ts` by none at all. Both decide which account an agent
// launches under: pick the wrong entry, or fail to retarget the Bullseye policy that
// pins an exhausted profile by name, and every workspace after it runs on the wrong
// subscription. That misattributes cost and, on a project pinned to a client account,
// is a boundary violation rather than an inconvenience.
//
// Scoped deliberately to the PURE core (selection, parsing, cooldowns, blob rewriting).
// The filesystem probes (`discoverProfiles`, `dirHasAuth`) and `rotateRing`'s pref
// writes read real state and belong in an integration suite, not the fast gate loop.

import { describe, it, expect } from "vitest";
import {
  parseRing,
  findRingEntry,
  ringProfileNames,
  makeCooldownKey,
  pickNext,
  fallbackCooldownIso,
  resolveDir,
  defaultDir,
  trimmedStringField,
  type AuthRingConfig,
  type BaseRingEntry,
} from "../services/auth-rotation-ring.js";
import { retargetProviderPolicyProfile } from "../services/strategy-policy-mutation.js";

interface TestEntry extends BaseRingEntry {
  configDir?: string;
  settingsProfile?: string;
}

const CFG: AuthRingConfig<TestEntry> = {
  provider: "claude",
  dirPrefix: ".claude-",
  discoverAuthFiles: [".credentials.json"],
  authFiles: [".credentials.json"],
  ringPrefKey: "claude_ring",
  profilePrefKey: "claude_profile",
  rotationDisabledPrefKey: "claude_rotation_enabled",
  cooldownPrefix: "claude_cooldown_",
  defaultCooldownMs: 5 * 60 * 60 * 1000,
  noun: "subscription",
  skipProfiles: ["mock"],
  parseEntry: (rec, profile) => ({
    profile,
    configDir: trimmedStringField(rec.configDir),
    settingsProfile: trimmedStringField(rec.settingsProfile),
  }),
  getDir: (e) => e.configDir,
  getApiKeyRef: (e) => e.settingsProfile,
};

const ring = (...profiles: string[]): TestEntry[] => profiles.map((profile) => ({ profile }));

describe("auth rotation ring — parsing (#648)", () => {
  it("returns an empty ring for absent, blank, non-array and unparseable values", () => {
    expect(parseRing(CFG, null)).toEqual([]);
    expect(parseRing(CFG, undefined)).toEqual([]);
    expect(parseRing(CFG, "   ")).toEqual([]);
    expect(parseRing(CFG, "{not json")).toEqual([]);
    // A stored OBJECT rather than an array is the shape a hand-edit most plausibly
    // produces; it must degrade to "no ring", never throw on the launch path.
    expect(parseRing(CFG, JSON.stringify({ profile: "a" }))).toEqual([]);
  });

  it("skips entries with no usable profile name rather than admitting a nameless login", () => {
    const parsed = parseRing(CFG, JSON.stringify([
      { profile: "work" },
      { profile: "   " },
      { profile: 42 },
      null,
      "work2",
      { configDir: "/somewhere" },
      { profile: "  personal  " },
    ]));
    expect(parsed.map((e) => e.profile)).toEqual(["work", "personal"]);
  });

  it("carries the provider-specific fields through parseEntry", () => {
    const parsed = parseRing(CFG, JSON.stringify([
      { profile: "work", configDir: "/custom/dir" },
      { profile: "api", settingsProfile: "settings_api" },
    ]));
    expect(parsed[0].configDir).toBe("/custom/dir");
    expect(parsed[1].settingsProfile).toBe("settings_api");
  });
});

describe("auth rotation ring — lookup (#648)", () => {
  it("finds an entry by name", () => {
    expect(findRingEntry(ring("a", "b"), "b")?.profile).toBe("b");
  });

  it("never matches the sentinel `default`, even if a ring entry is literally named that", () => {
    // "default" means "the provider's own configured login", not a ring member —
    // resolving it to a dir override would silently launch under the wrong account.
    expect(findRingEntry(ring("default", "a"), "default")).toBeUndefined();
    expect(findRingEntry(ring("a"), undefined)).toBeUndefined();
  });

  it("lists the ring's profile names", () => {
    expect(ringProfileNames(ring("a", "b", "c"))).toEqual(["a", "b", "c"]);
  });

  it("builds the cooldown key from the provider's prefix", () => {
    expect(makeCooldownKey(CFG, "work")).toBe("claude_cooldown_work");
  });
});

describe("auth rotation ring — pickNext (#648)", () => {
  const now = new Date("2026-08-18T12:00:00.000Z");
  const future = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const past = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  it("returns the entry after the current one, in ring order", () => {
    expect(pickNext(CFG, ring("a", "b", "c"), "a", new Map(), now)?.profile).toBe("b");
  });

  it("wraps around the end of the ring", () => {
    expect(pickNext(CFG, ring("a", "b", "c"), "c", new Map(), now)?.profile).toBe("a");
  });

  it("skips a profile whose cooldown has not elapsed", () => {
    const prefs = new Map([["claude_cooldown_b", future]]);
    expect(pickNext(CFG, ring("a", "b", "c"), "a", prefs, now)?.profile).toBe("c");
  });

  it("treats an ELAPSED cooldown as available — a stamp is not a permanent ban", () => {
    const prefs = new Map([["claude_cooldown_b", past]]);
    expect(pickNext(CFG, ring("a", "b", "c"), "a", prefs, now)?.profile).toBe("b");
  });

  it("treats an unparseable cooldown stamp as available rather than losing the login", () => {
    const prefs = new Map([["claude_cooldown_b", "not-a-date"]]);
    expect(pickNext(CFG, ring("a", "b", "c"), "a", prefs, now)?.profile).toBe("b");
  });

  it("returns undefined when every OTHER entry is cooling", () => {
    const prefs = new Map([
      ["claude_cooldown_b", future],
      ["claude_cooldown_c", future],
    ]);
    expect(pickNext(CFG, ring("a", "b", "c"), "a", prefs, now)).toBeUndefined();
  });

  it("never re-picks the exhausted current profile, even as the only ring member", () => {
    expect(pickNext(CFG, ring("a"), "a", new Map(), now)).toBeUndefined();
  });

  it("starts from the head when the current profile is not in the ring", () => {
    // findIndex returns -1, so offset 1 lands on index 0 — the first entry, which is
    // the sensible reading of "rotate away from something the ring never knew about".
    expect(pickNext(CFG, ring("a", "b"), "unknown", new Map(), now)?.profile).toBe("a");
    expect(pickNext(CFG, ring("a", "b"), undefined, new Map(), now)?.profile).toBe("a");
  });

  it("returns undefined for an empty ring", () => {
    expect(pickNext(CFG, [], "a", new Map(), now)).toBeUndefined();
  });

  it("derives the fallback cooldown from the provider's window", () => {
    expect(fallbackCooldownIso(CFG, now)).toBe("2026-08-18T17:00:00.000Z");
  });
});

describe("auth rotation ring — resolveDir (#648)", () => {
  it("returns no dir override for an api-key login", () => {
    expect(resolveDir(CFG, { profile: "api", settingsProfile: "settings_api" })).toBeUndefined();
  });

  it("prefers an explicit dir, and infers `<prefix><profile>` otherwise", () => {
    expect(resolveDir(CFG, { profile: "work", configDir: "/custom/dir" })).toBe("/custom/dir");
    expect(resolveDir(CFG, { profile: "work" })).toBe(defaultDir(CFG, "work"));
    // A whitespace-only override is not a choice — fall back rather than launch with "".
    expect(resolveDir(CFG, { profile: "work", configDir: "   " })).toBe(defaultDir(CFG, "work"));
  });

  it("an api-key ref wins over a configured dir", () => {
    expect(resolveDir(CFG, { profile: "both", configDir: "/d", settingsProfile: "s" })).toBeUndefined();
  });
});

describe("retargetProviderPolicyProfile (#648)", () => {
  const blob = (policies: unknown) => JSON.stringify({ weights: { speed: 3 }, providerPolicies: policies });

  it("repoints every matching policy and leaves the rest untouched", () => {
    const raw = blob([
      { provider: "claude", profileName: "work", extra: "kept" },
      { provider: "claude", profileName: "personal" },
      { provider: "codex", profileName: "work" },
      { provider: "claude", profileName: "work" },
    ]);

    const out = retargetProviderPolicyProfile(raw, "claude", "work", "backup");
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!) as { weights: unknown; providerPolicies: Record<string, unknown>[] };
    expect(parsed.providerPolicies.map((p) => `${String(p.provider)}:${String(p.profileName)}`)).toEqual([
      "claude:backup", "claude:personal", "codex:work", "claude:backup",
    ]);
    // Raw-parse + re-serialize, NOT parse->normalize->emit: fields this module has never
    // heard of have to survive, or a rotation silently truncates the operator's Bullseye.
    expect(parsed.providerPolicies[0].extra).toBe("kept");
    expect(parsed.weights).toEqual({ speed: 3 });
  });

  it("returns null when nothing matched, so the caller skips the write", () => {
    expect(retargetProviderPolicyProfile(blob([{ provider: "claude", profileName: "other" }]), "claude", "work", "backup")).toBeNull();
    expect(retargetProviderPolicyProfile(blob([{ provider: "codex", profileName: "work" }]), "claude", "work", "backup")).toBeNull();
  });

  it("returns null for blobs it cannot safely rewrite", () => {
    expect(retargetProviderPolicyProfile("{not json", "claude", "a", "b")).toBeNull();
    expect(retargetProviderPolicyProfile("null", "claude", "a", "b")).toBeNull();
    expect(retargetProviderPolicyProfile('"a string"', "claude", "a", "b")).toBeNull();
    expect(retargetProviderPolicyProfile(JSON.stringify({}), "claude", "a", "b")).toBeNull();
    expect(retargetProviderPolicyProfile(blob("not-an-array"), "claude", "a", "b")).toBeNull();
  });

  it("skips non-object policy entries instead of throwing on them", () => {
    const out = retargetProviderPolicyProfile(
      blob([null, "junk", 7, { provider: "claude", profileName: "work" }]),
      "claude", "work", "backup",
    );
    const parsed = JSON.parse(out!) as { providerPolicies: unknown[] };
    expect(parsed.providerPolicies[3]).toEqual({ provider: "claude", profileName: "backup" });
  });
});
