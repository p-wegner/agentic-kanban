import { describe, it, expect } from "vitest";
import {
  parseProfileAllowlist,
  serializeProfileAllowlist,
  clampProfileToAllowlist,
  isProfileAllowed,
  isProfileCooling,
  profileCooldownKey,
  allowedProfileId,
} from "../src/lib/profile-allowlist.js";

const NOW_MS = Date.parse("2026-08-18T09:00:00.000Z");
const COOLING = new Date(NOW_MS + 60 * 60 * 1000).toISOString();
const ELAPSED = new Date(NOW_MS - 60 * 60 * 1000).toISOString();

function prefs(entries: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe("parseProfileAllowlist", () => {
  it("treats absent and blank as unrestricted, not as restricted-to-nothing", () => {
    for (const raw of [undefined, null, "", "   "]) {
      const parsed = parseProfileAllowlist(raw);
      expect(parsed.restricted).toBe(false);
      expect(parsed.malformed).toBe(false);
      expect(parsed.entries).toEqual([]);
    }
  });

  it("parses the canonical object form and keeps declared order", () => {
    const parsed = parseProfileAllowlist(
      '[{"provider":"claude","name":"andrena_team_5x_2"},{"provider":"claude","name":"andrena_team_5x"}]',
    );
    expect(parsed.restricted).toBe(true);
    expect(parsed.entries.map(allowedProfileId)).toEqual([
      "claude:andrena_team_5x_2",
      "claude:andrena_team_5x",
    ]);
  });

  it("accepts compact provider:name strings and a bare comma-separated list", () => {
    expect(parseProfileAllowlist('["codex:work","claude:home"]').entries.map(allowedProfileId))
      .toEqual(["codex:work", "claude:home"]);
    // Hand-editing convenience: not JSON at all.
    expect(parseProfileAllowlist("claude:a, codex:b").entries.map(allowedProfileId))
      .toEqual(["claude:a", "codex:b"]);
  });

  it("defaults a bare profile name to claude", () => {
    expect(parseProfileAllowlist('["andrena_team_5x_2"]').entries)
      .toEqual([{ provider: "claude", name: "andrena_team_5x_2" }]);
  });

  it("narrows an unknown provider rather than dropping the entry", () => {
    // Dropping it would silently shrink the allowlist, which can only ever be more
    // restrictive than the operator wrote — and at zero entries it becomes a hold.
    expect(parseProfileAllowlist('[{"provider":"wat","name":"x"}]').entries)
      .toEqual([{ provider: "claude", name: "x" }]);
  });

  it("dedupes by provider:name", () => {
    const parsed = parseProfileAllowlist('["claude:a","claude:a",{"provider":"claude","name":"a"}]');
    expect(parsed.entries).toHaveLength(1);
  });

  it("an explicit empty array lifts the restriction", () => {
    const parsed = parseProfileAllowlist("[]");
    expect(parsed.restricted).toBe(false);
    expect(parsed.malformed).toBe(false);
  });

  it("fails CLOSED on a present-but-unusable value", () => {
    // The failure this prevents: a typo'd allowlist reading as "unrestricted" would let a
    // project spend the wrong subscription with no error anywhere.
    for (const raw of ["[not json", '[{"provider":"claude"}]', "[null]", '[""]']) {
      const parsed = parseProfileAllowlist(raw);
      expect(parsed.malformed, raw).toBe(true);
      expect(parsed.restricted, raw).toBe(true);
      expect(parsed.entries, raw).toEqual([]);
    }
  });

  it("round-trips through serialize", () => {
    const entries = [
      { provider: "claude" as const, name: "andrena_team_5x_2" },
      { provider: "codex" as const, name: "work" },
    ];
    expect(parseProfileAllowlist(serializeProfileAllowlist(entries)).entries).toEqual(entries);
  });
});

describe("cooldown reading", () => {
  it("uses the same key shape the rotation rings write", () => {
    expect(profileCooldownKey("claude", "team")).toBe("claude_cooldown_team");
    expect(profileCooldownKey("codex", "work")).toBe("codex_cooldown_work");
  });

  it("is cooling only while the stamp is in the future", () => {
    const entry = { provider: "claude" as const, name: "a" };
    expect(isProfileCooling(entry, prefs(), NOW_MS)).toBe(false);
    expect(isProfileCooling(entry, prefs({ claude_cooldown_a: COOLING }), NOW_MS)).toBe(true);
    expect(isProfileCooling(entry, prefs({ claude_cooldown_a: ELAPSED }), NOW_MS)).toBe(false);
  });

  it("treats an unparseable stamp as available, matching auth-rotation-ring", () => {
    // Otherwise a junk stamp would pin a profile off permanently with no way to clear it
    // from the UI.
    expect(isProfileCooling({ provider: "claude", name: "a" }, prefs({ claude_cooldown_a: "soon" }), NOW_MS))
      .toBe(false);
  });
});

describe("isProfileAllowed", () => {
  const allowlist = parseProfileAllowlist('["claude:pinned"]');

  it("permits everything when unrestricted", () => {
    expect(isProfileAllowed(parseProfileAllowlist(""), "claude", "anything")).toBe(true);
  });

  it("matches on provider AND name", () => {
    expect(isProfileAllowed(allowlist, "claude", "pinned")).toBe(true);
    expect(isProfileAllowed(allowlist, "codex", "pinned")).toBe(false);
    expect(isProfileAllowed(allowlist, "claude", "other")).toBe(false);
  });

  it("rejects an empty profile name under a restriction", () => {
    expect(isProfileAllowed(allowlist, "claude", "")).toBe(false);
  });
});

describe("clampProfileToAllowlist", () => {
  const pinned = parseProfileAllowlist('[{"provider":"claude","name":"andrena_team_5x_2"}]');

  it("is a no-op with no restriction", () => {
    const result = clampProfileToAllowlist({
      allowlist: parseProfileAllowlist(""),
      provider: "codex",
      profileName: "whatever",
      prefMap: prefs(),
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ selection: null, clamped: false, holdReason: null, note: null });
  });

  it("passes an allowed profile through silently", () => {
    const result = clampProfileToAllowlist({
      allowlist: pinned,
      provider: "claude",
      profileName: "andrena_team_5x_2",
      prefMap: prefs(),
      nowMs: NOW_MS,
    });
    expect(result.selection).toEqual({ provider: "claude", name: "andrena_team_5x_2" });
    expect(result.clamped).toBe(false);
    // The common path must not log — otherwise every launch narrates itself.
    expect(result.note).toBeNull();
  });

  it("clamps a disallowed profile and says so", () => {
    const result = clampProfileToAllowlist({
      allowlist: pinned,
      provider: "claude",
      profileName: "some_other_account",
      prefMap: prefs(),
      nowMs: NOW_MS,
    });
    expect(result.selection).toEqual({ provider: "claude", name: "andrena_team_5x_2" });
    expect(result.clamped).toBe(true);
    expect(result.holdReason).toBeNull();
    expect(result.note).toContain("not allowed");
  });

  it("clamps across providers, not just profile names", () => {
    const result = clampProfileToAllowlist({
      allowlist: pinned,
      provider: "codex",
      profileName: "work",
      prefMap: prefs(),
      nowMs: NOW_MS,
    });
    expect(result.selection).toEqual({ provider: "claude", name: "andrena_team_5x_2" });
    expect(result.clamped).toBe(true);
  });

  it("rotates within the allowlist when the first choice is cooling", () => {
    const two = parseProfileAllowlist('["claude:a","claude:b"]');
    const result = clampProfileToAllowlist({
      allowlist: two,
      provider: "claude",
      profileName: "a",
      prefMap: prefs({ claude_cooldown_a: COOLING }),
      nowMs: NOW_MS,
    });
    expect(result.selection).toEqual({ provider: "claude", name: "b" });
    expect(result.clamped).toBe(true);
    expect(result.note).toContain("cooling");
  });

  it("HOLDS instead of falling back when every allowed profile is cooling", () => {
    const two = parseProfileAllowlist('["claude:a","claude:b"]');
    const result = clampProfileToAllowlist({
      allowlist: two,
      provider: "claude",
      profileName: "a",
      prefMap: prefs({ claude_cooldown_a: COOLING, claude_cooldown_b: COOLING }),
      nowMs: NOW_MS,
    });
    expect(result.selection).toBeNull();
    expect(result.holdReason).toContain("every allowed profile is cooling");
    expect(result.holdReason).toContain(COOLING);
  });

  it("a single-entry allowlist holds as soon as its one profile cools", () => {
    // This is the comet case: pinned to one client subscription, so a limit means wait,
    // never "use the other account".
    const result = clampProfileToAllowlist({
      allowlist: pinned,
      provider: "claude",
      profileName: "andrena_team_5x_2",
      prefMap: prefs({ claude_cooldown_andrena_team_5x_2: COOLING }),
      nowMs: NOW_MS,
    });
    expect(result.selection).toBeNull();
    expect(result.holdReason).toBeTruthy();
  });

  it("HOLDS on a malformed allowlist rather than launching unrestricted", () => {
    const result = clampProfileToAllowlist({
      allowlist: parseProfileAllowlist("[garbage"),
      provider: "claude",
      profileName: "anything",
      prefMap: prefs(),
      nowMs: NOW_MS,
    });
    expect(result.selection).toBeNull();
    expect(result.holdReason).toContain("unparseable");
  });

  it("supplies a profile when the resolver produced none", () => {
    const result = clampProfileToAllowlist({
      allowlist: pinned,
      provider: "claude",
      profileName: null,
      prefMap: prefs(),
      nowMs: NOW_MS,
    });
    expect(result.selection).toEqual({ provider: "claude", name: "andrena_team_5x_2" });
    expect(result.clamped).toBe(true);
    expect(result.note).toContain("no profile resolved");
  });
});
