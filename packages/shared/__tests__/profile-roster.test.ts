/**
 * The profile roster (#1025): parsing, the narrowing rule, headroom ordering, reserve
 * gating and the forbidden refusal — the pure half. The enforcement seam is exercised in
 * `packages/server/src/__tests__/project-profile-roster.test.ts`, and the legacy allowlist
 * behaviour this must not disturb in `profile-allowlist.test.ts` (unchanged by #1025).
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_POOL_EXHAUSTED_PCT,
  mostRestrictiveRole,
  parseRoster,
  profileRefId,
  reserveAllowedPrefKey,
  resolvePoolExhaustedPct,
  resolveProjectRoster,
  resolveReserveAllowance,
  rosterExhaustedPctPrefKey,
  rosterPrefKey,
  serializeRoster,
  type RosterEntry,
} from "../src/lib/profile-roster.js";
import {
  headroomFromQuotaUsage,
  rankRosterEntries,
  resolveRosterSelection,
  type ProfileHeadroom,
} from "../src/lib/profile-roster-selection.js";

const PROJECT_ID = "11111111-2222-3333-4444-555555555555";
const NOW_MS = Date.parse("2026-09-04T09:00:00.000Z");
const COOLING = new Date(NOW_MS + 60 * 60 * 1000).toISOString();

function prefs(entries: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries(entries));
}

function entry(name: string, role: RosterEntry["role"] = "pool"): RosterEntry {
  return { provider: "claude", name, role };
}

function headroom(pairs: Record<string, ProfileHeadroom>): Map<string, ProfileHeadroom> {
  return new Map(Object.entries(pairs));
}

describe("parseRoster", () => {
  it("reads the canonical object form with roles", () => {
    const parsed = parseRoster('[{"provider":"claude","name":"anth","role":"pool"},{"provider":"claude","name":"privat","role":"reserve"}]');
    expect(parsed.restricted).toBe(true);
    expect(parsed.closed).toBe(true);
    expect(parsed.entries.map((e) => `${profileRefId(e)}=${e.role}`)).toEqual([
      "claude:anth=pool",
      "claude:privat=reserve",
    ]);
  });

  it("reads the compact string form, with and without a role", () => {
    const parsed = parseRoster("claude:anth, claude:training:forbidden, claude:privat:reserve");
    expect(parsed.entries.map((e) => `${profileRefId(e)}=${e.role}`)).toEqual([
      "claude:anth=pool",
      "claude:training=forbidden",
      "claude:privat=reserve",
    ]);
  });

  it("a TWO-part string stays provider:name — the legacy allowlist form is never re-read as a role", () => {
    // `"privat:reserve"` must keep meaning the profile `reserve` under provider `privat`
    // (narrowed to claude), exactly as it did before roles existed. Only a third segment
    // declares a role, so no stored allowlist value can change meaning under #1025.
    expect(parseRoster('["privat:reserve"]').entries).toEqual([
      { provider: "claude", name: "reserve", role: "pool" },
    ]);
  });

  it("defaults an entry with no role to pool — an allowlist IS an all-pool roster", () => {
    const legacy = parseRoster('[{"provider":"claude","name":"anth"},{"provider":"codex","name":"work"}]', "allowed_profiles");
    expect(legacy.entries.every((e) => e.role === "pool")).toBe(true);
    expect(legacy.source).toBe("allowed_profiles");
  });

  it("fails CLOSED on a present-but-unusable value", () => {
    for (const raw of ["[not json", '[{"provider":"claude"}]', "[null]"]) {
      const parsed = parseRoster(raw);
      expect(parsed.malformed, raw).toBe(true);
      expect(parsed.restricted, raw).toBe(true);
    }
  });

  it("round-trips through serializeRoster", () => {
    const entries = [entry("anth"), entry("privat", "reserve")];
    expect(parseRoster(serializeRoster(entries)).entries.map((e) => `${e.name}=${e.role}`))
      .toEqual(["anth=pool", "privat=reserve"]);
  });
});

describe("resolveProjectRoster — the narrowing rule", () => {
  const globals = [entry("anth"), entry("team5x"), entry("privat", "reserve"), entry("training", "forbidden")];

  it("is UNRESTRICTED when nothing declares a role — today's behaviour, byte for byte", () => {
    const roster = resolveProjectRoster({ globalRoster: [entry("anth"), entry("team5x")] });
    expect(roster.restricted).toBe(false);
    expect(roster.closed).toBe(false);
  });

  it("restricts as soon as one observed profile is not pool, but stays OPEN", () => {
    const roster = resolveProjectRoster({ globalRoster: globals });
    expect(roster.restricted).toBe(true);
    expect(roster.closed).toBe(false);
  });

  it("a project roster may narrow pool -> reserve", () => {
    const roster = resolveProjectRoster({
      globalRoster: globals,
      rosterRaw: '["claude:anth:reserve"]',
    });
    expect(roster.entries).toEqual([{ provider: "claude", name: "anth", role: "reserve" }]);
    expect(roster.closed).toBe(true);
  });

  it("a project roster may NOT widen forbidden -> pool", () => {
    const roster = resolveProjectRoster({
      globalRoster: globals,
      rosterRaw: '["claude:training:pool","claude:privat:pool"]',
    });
    expect(roster.entries.map((e) => `${e.name}=${e.role}`)).toEqual([
      // A global forbidden is unliftable BY CONSTRUCTION, and reserve survives too.
      "training=forbidden",
      "privat=reserve",
    ]);
  });

  it("a dedicated profile is forbidden for every project but the one it names", () => {
    const dedicated: RosterEntry[] = [{ provider: "claude", name: "kunde-x", role: "pool", dedicatedProject: "kunde-x" }];
    expect(resolveProjectRoster({ globalRoster: dedicated, projectSlug: "kunde-x" }).entries[0].role).toBe("pool");
    expect(resolveProjectRoster({ globalRoster: dedicated, projectSlug: "other" }).entries[0].role).toBe("forbidden");
  });

  it("reads a legacy allowlist as an all-pool roster, and prefers a roster when both exist", () => {
    const migrated = resolveProjectRoster({ allowlistRaw: '["claude:anth","claude:team5x"]' });
    expect(migrated.source).toBe("allowed_profiles");
    expect(migrated.entries.every((e) => e.role === "pool")).toBe(true);

    const both = resolveProjectRoster({ rosterRaw: '["claude:privat:reserve"]', allowlistRaw: '["claude:anth"]' });
    expect(both.source).toBe("roster");
    expect(both.entries.map((e) => e.name)).toEqual(["privat"]);
  });
});

describe("rankRosterEntries — remaining 5-hour headroom first", () => {
  it("orders by remaining headroom, not list order", () => {
    const ranked = rankRosterEntries(
      [entry("a"), entry("b"), entry("c")],
      headroom({ "claude:a": { usedPct: 70 }, "claude:b": { usedPct: 10 }, "claude:c": { usedPct: 40 } }),
    );
    expect(ranked.map((e) => e.name)).toEqual(["b", "c", "a"]);
  });

  it("sorts an UNKNOWN measurement after every fresh one — never as exhausted", () => {
    const ranked = rankRosterEntries(
      [entry("unknown"), entry("stale"), entry("measured")],
      headroom({ "claude:measured": { usedPct: 88 }, "claude:stale": { usedPct: 2, stale: true } }),
    );
    // 88% used is worse than "we don't know", and it still ranks first: an unknown profile
    // is not evidence of headroom, so it must not displace a profile we measured.
    expect(ranked.map((e) => e.name)).toEqual(["measured", "unknown", "stale"]);
  });

  it("keeps declared order when nothing is measured at all", () => {
    expect(rankRosterEntries([entry("a"), entry("b")], null).map((e) => e.name)).toEqual(["a", "b"]);
  });
});

describe("resolveRosterSelection — per role", () => {
  const closedRoster = (raw: string) => parseRoster(raw);

  function decide(raw: string, over: Partial<Parameters<typeof resolveRosterSelection>[0]> = {}) {
    return resolveRosterSelection({
      roster: closedRoster(raw),
      provider: "claude",
      profileName: "anth",
      prefMap: prefs(),
      nowMs: NOW_MS,
      ...over,
    });
  }

  it("pool: passes an already-permitted, healthy selection through with no note", () => {
    const result = decide('["claude:anth","claude:team5x"]');
    expect(result.selection).toMatchObject({ name: "anth" });
    expect(result.clamped).toBe(false);
    expect(result.note).toBeNull();
  });

  it("pool: clamps onto the profile with the most remaining headroom", () => {
    const result = decide('["claude:a","claude:b"]', {
      headroom: headroom({ "claude:a": { usedPct: 60 }, "claude:b": { usedPct: 5 } }),
    });
    expect(result.selection?.name).toBe("b");
    expect(result.clamped).toBe(true);
  });

  it("pool: a profile at or over the threshold is exhausted", () => {
    const result = decide('["claude:a","claude:b"]', {
      profileName: "a",
      headroom: headroom({ "claude:a": { usedPct: 95 }, "claude:b": { usedPct: 50 } }),
    });
    expect(result.selection?.name).toBe("b");
    expect(result.note).toContain("exhausted");
  });

  it("forbidden: REFUSES an explicit request instead of clamping to something else", () => {
    const result = decide('["claude:anth:forbidden","claude:team5x"]');
    expect(result.refused).toBe(true);
    expect(result.selection).toBeNull();
    expect(result.holdReason).toContain("forbidden");
    // The point of a refusal: the healthy alternative is NOT quietly substituted.
    expect(result.note).not.toContain("launching on");
  });

  it("reserve: is withheld until a grant permits it", () => {
    const raw = '["claude:a","claude:privat:reserve"]';
    const withheld = decide(raw, { profileName: "a", prefMap: prefs({ claude_cooldown_a: COOLING }) });
    expect(withheld.selection).toBeNull();
    expect(withheld.holdReason).toContain("reserve is not allowed");

    const granted = decide(raw, {
      profileName: "a",
      prefMap: prefs({ claude_cooldown_a: COOLING }),
      reserveAllowed: true,
    });
    expect(granted.selection?.name).toBe("privat");
    expect(granted.usedReserve).toBe(true);
    expect(granted.reserveNote).toContain("RESERVE");
  });

  it("reserve: is NOT taken while any pool profile is still usable", () => {
    const result = decide('["claude:a","claude:privat:reserve"]', { profileName: "a", reserveAllowed: true });
    expect(result.selection?.name).toBe("a");
    expect(result.usedReserve).toBe(false);
  });

  it("a fully exhausted project roster HOLDS rather than borrowing", () => {
    const result = decide('["claude:a"]', {
      profileName: "a",
      headroom: headroom({ "claude:a": { usedPct: 99 } }),
    });
    expect(result.selection).toBeNull();
    expect(result.holdReason).toContain("exhausted or cooling");
  });

  it("an OPEN roster restricts nothing but the roles it names", () => {
    const roster = resolveProjectRoster({ globalRoster: [entry("training", "forbidden"), entry("anth")] });
    const unrelated = resolveRosterSelection({
      roster,
      provider: "claude",
      profileName: "some_other_account",
      prefMap: prefs(),
      nowMs: NOW_MS,
    });
    expect(unrelated.selection?.name).toBe("some_other_account");
    expect(unrelated.refused).toBe(false);

    const forbidden = resolveRosterSelection({
      roster,
      provider: "claude",
      profileName: "training",
      prefMap: prefs(),
      nowMs: NOW_MS,
    });
    expect(forbidden.refused).toBe(true);
  });
});

describe("reserve grants and the threshold", () => {
  it("accepts the project flag, the ticket tag and an operator start — and nothing else", () => {
    expect(resolveReserveAllowance({ prefMap: prefs(), projectId: PROJECT_ID }).allowed).toBe(false);
    expect(
      resolveReserveAllowance({
        prefMap: prefs({ [reserveAllowedPrefKey(PROJECT_ID)]: "true" }),
        projectId: PROJECT_ID,
      }).allowed,
    ).toBe(true);
    expect(
      resolveReserveAllowance({ prefMap: prefs(), projectId: PROJECT_ID, issueTags: ["urgent", "reserve:ok"] }).allowed,
    ).toBe(true);
    expect(resolveReserveAllowance({ prefMap: prefs(), projectId: PROJECT_ID, operatorStart: true }).allowed).toBe(true);
  });

  it("falls back to the default threshold for an absent or nonsensical value", () => {
    expect(resolvePoolExhaustedPct(prefs(), PROJECT_ID)).toBe(DEFAULT_POOL_EXHAUSTED_PCT);
    expect(resolvePoolExhaustedPct(prefs({ [rosterExhaustedPctPrefKey(PROJECT_ID)]: "oops" }), PROJECT_ID))
      .toBe(DEFAULT_POOL_EXHAUSTED_PCT);
    expect(resolvePoolExhaustedPct(prefs({ [rosterExhaustedPctPrefKey(PROJECT_ID)]: "75" }), PROJECT_ID)).toBe(75);
  });

  it("builds the per-project keys the registry recognizes", () => {
    expect(rosterPrefKey(PROJECT_ID)).toBe(`roster_${PROJECT_ID}`);
    expect(reserveAllowedPrefKey(PROJECT_ID)).toBe(`reserve_allowed_${PROJECT_ID}`);
  });
});

describe("headroomFromQuotaUsage", () => {
  it("projects the 5-hour metric and marks an unknown/stale entry", () => {
    const map = headroomFromQuotaUsage({
      providers: [
        { id: "anth", status: "ok", stale: false, metrics: [{ label: "5h", percent: 42, periodMs: 5 * 60 * 60 * 1000 }] },
        { id: "old", status: "unknown", stale: true, metrics: [{ label: "5h", percent: 3, periodMs: 5 * 60 * 60 * 1000 }] },
      ],
    });
    expect(map.get("claude:anth")).toEqual({ usedPct: 42, stale: false });
    // Keyed by the bare name too: the quota source names a Claude profile without a provider.
    expect(map.get("anth")?.usedPct).toBe(42);
    expect(map.get("claude:old")).toEqual({ usedPct: null, stale: true });
  });
});
