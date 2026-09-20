/**
 * Headroom decides BEFORE the start (#1026).
 *
 * #1025 gave the roster an ordering and an exhaustion threshold but fed it no measurements
 * on the launch path, and the Bullseye's priority list still broke ties by declared order —
 * so the first account in the list was picked however close to its cap it was, and the
 * rotation ring only moved off it AFTER a session had burned a start on the usage-limit
 * text. This pins the two halves of the fix: the Bullseye ranks a tier by measured 5-hour
 * headroom and skips an exhausted entry, and the resolved launch carries a record of WHY.
 *
 * The negative cases matter as much as the positive one: with nothing measured the result
 * must be byte-for-byte the old list order, and a healthy explicit choice must still be
 * kept — preempting one by headroom is predictive rotation, which #1025 deliberately
 * refused and this ticket does not introduce.
 */
import { describe, expect, it } from "vitest";
import {
  resolveProjectRuntimeConfig,
  rosterPrefKey,
} from "../services/project-runtime-config.service.js";
import { selectProviderFromStrategy } from "../services/strategy-objective.service.js";
import type { ProviderProfilePolicy } from "@agentic-kanban/shared/lib/strategy-policy";
import type { ProfileHeadroom, RosterEntry } from "@agentic-kanban/shared/lib/profile-allowlist";
import { headroomFromQuotaUsage } from "@agentic-kanban/shared/lib/profile-allowlist";
import { parseProfileSelectionReason, serializeProfileSelectionReason } from "../lib/profile-selection-reason.js";

const PROJECT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NOW_MS = Date.parse("2026-09-04T09:00:00.000Z");
const COOLING_UNTIL = new Date(NOW_MS + 60 * 60 * 1000).toISOString();

const GLOBAL: RosterEntry[] = [
  { provider: "claude", name: "anth", role: "pool" },
  { provider: "claude", name: "team5x", role: "pool" },
];

function headroom(pairs: Record<string, ProfileHeadroom>): Map<string, ProfileHeadroom> {
  return new Map(Object.entries(pairs));
}

function policy(profileName: string, extra: Partial<ProviderProfilePolicy> = {}): ProviderProfilePolicy {
  return {
    id: `claude:${profileName}`,
    provider: "claude",
    profileName,
    label: `Claude ${profileName}`,
    mode: "fill",
    headroomPct: 0,
    notes: "",
    ...extra,
  };
}

function prefs(entries: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries({ provider: "claude", ...entries }));
}

function resolve(
  prefMap: Map<string, string>,
  input: Partial<Parameters<typeof resolveProjectRuntimeConfig>[0]> = {},
) {
  return resolveProjectRuntimeConfig({
    projectId: PROJECT_ID,
    prefMap,
    nowMs: NOW_MS,
    globalRoster: GLOBAL,
    ...input,
  });
}

describe("Bullseye selection ranks a tier by measured headroom (#1026)", () => {
  const config = { providerPolicies: [policy("anth"), policy("team5x")] };

  it("picks the profile with more remaining headroom when the priority list leaves a choice", () => {
    const selected = selectProviderFromStrategy(config, {
      headroom: headroom({ "claude:anth": { usedPct: 95 }, "claude:team5x": { usedPct: 20 } }),
    });
    expect(selected?.profileName).toBe("team5x");
    expect(selected?.usedPct).toBe(20);
    // The loser is carried with its own reading — the number is gone minutes later.
    expect(selected?.candidates).toEqual([
      { id: "claude:anth", usedPct: 95, exhausted: true },
      { id: "claude:team5x", usedPct: 20, exhausted: false },
    ]);
  });

  it("keeps DECLARED order when nothing is measured — the pre-#1026 behaviour exactly", () => {
    expect(selectProviderFromStrategy(config)?.profileName).toBe("anth");
    expect(
      selectProviderFromStrategy(config, {
        headroom: headroom({
          "claude:anth": { usedPct: null, stale: true },
          "claude:team5x": { usedPct: null, stale: true },
        }),
      })?.profileName,
    ).toBe("anth");
  });

  it("an unmeasured profile never outranks a measured one, and is never read as exhausted", () => {
    // `anth` is unknown, `team5x` is measured and healthy: the measurement wins the tie…
    expect(
      selectProviderFromStrategy(config, {
        headroom: headroom({ "claude:team5x": { usedPct: 10 } }),
      })?.profileName,
    ).toBe("team5x");
    // …but an unknown reading is not exhaustion: with the measured one over the threshold,
    // the unmeasured account is still launchable rather than dropped out of rotation.
    expect(
      selectProviderFromStrategy(config, {
        headroom: headroom({ "claude:team5x": { usedPct: 99 } }),
      })?.profileName,
    ).toBe("anth");
  });

  it("SKIPS an exhausted entry before the start rather than waiting for the ring's limit text", () => {
    const selected = selectProviderFromStrategy(config, {
      headroom: headroom({ "claude:anth": { usedPct: 96 }, "claude:team5x": { usedPct: 96 } }),
      exhaustedPct: 95,
    });
    // Both are over: nothing in this tier is selectable, and the caller holds rather than
    // launching onto an account that is about to refuse the work.
    expect(selected).toBeNull();
  });

  it("honours the project's own threshold, not a hardcoded one", () => {
    const opts = { headroom: headroom({ "claude:anth": { usedPct: 60 }, "claude:team5x": { usedPct: 70 } }) };
    expect(selectProviderFromStrategy(config, opts)?.profileName).toBe("anth");
    expect(selectProviderFromStrategy(config, { ...opts, exhaustedPct: 50 })).toBeNull();
  });

  it("falls through the priority tiers, ranking inside each one", () => {
    const tiered = {
      providerPolicies: [
        policy("anth", { mode: "fill" }),
        policy("team5x", { mode: "throttle" }),
        policy("privat", { mode: "throttle" }),
      ],
    };
    const selected = selectProviderFromStrategy(tiered, {
      headroom: headroom({
        "claude:anth": { usedPct: 99 },
        "claude:team5x": { usedPct: 80 },
        "claude:privat": { usedPct: 30 },
      }),
    });
    // The fill tier is exhausted, so throttle decides — and inside it, headroom does.
    expect(selected?.profileName).toBe("privat");
  });
});

describe("a quota reading never crosses providers", () => {
  it("does not judge a codex policy exhausted from the CLAUDE account of the same name", () => {
    // The quota source reads Claude logins and publishes a BARE `default` key alongside
    // `claude:default`. A Bullseye whose only policy was `codex:default` read that number,
    // called codex exhausted, selected nothing, and the caller fell back to the workspace's
    // baked provider — master's sweep went red on two suites for exactly this, green again
    // once the operator's own Claude account dropped back under the threshold.
    const codexOnly = {
      providerPolicies: [
        { id: "codex:default", provider: "codex" as const, profileName: "default", label: "Codex", mode: "fill" as const, headroomPct: 0, notes: "" },
      ],
    };
    const claudeDefaultExhausted = headroomFromQuotaUsage({
      providers: [{ id: "default", status: "ok", stale: false, metrics: [{ label: "5h", percent: 97, periodMs: 5 * 60 * 60 * 1000 }] }],
    });

    const selected = selectProviderFromStrategy(codexOnly, { headroom: claudeDefaultExhausted });

    expect(selected?.provider).toBe("codex");
    expect(selected?.profileName).toBe("default");
    expect(selected?.usedPct).toBeNull();
  });
});

describe("the launch records WHY this profile (#1026)", () => {
  it("A at 95% / B at 20% — the Bullseye picks B and the record says what lost", () => {
    const runtime = resolve(prefs(), {
      strategySelection: {
        provider: "claude",
        profileName: "team5x",
        usedPct: 20,
        candidates: [
          { id: "claude:anth", usedPct: 95, exhausted: true },
          { id: "claude:team5x", usedPct: 20, exhausted: false },
        ],
      },
    });
    expect(runtime.provider.profileName).toBe("team5x");
    const reason = runtime.provider.profileSelectionReason;
    expect(reason).toMatchObject({
      profile: "claude:team5x",
      usedPct: 20,
      source: "strategy",
      decidedBy: "headroom",
    });
    expect(reason?.candidates).toEqual([
      { id: "claude:anth", usedPct: 95, outcome: "exhausted" },
      { id: "claude:team5x", usedPct: 20, outcome: "selected" },
    ]);
    expect(reason?.summary).toContain("claude:anth");
    // Round-trips through the column it is stored in.
    expect(parseProfileSelectionReason(serializeProfileSelectionReason(reason))).toEqual(reason);
  });

  it("both unknown — list order decides, and the record says so rather than claiming headroom", () => {
    const runtime = resolve(prefs(), {
      strategySelection: {
        provider: "claude",
        profileName: "anth",
        usedPct: null,
        candidates: [
          { id: "claude:anth", usedPct: null, exhausted: false },
          { id: "claude:team5x", usedPct: null, exhausted: false },
        ],
      },
    });
    expect(runtime.provider.profileName).toBe("anth");
    expect(runtime.provider.profileSelectionReason).toMatchObject({
      profile: "claude:anth",
      usedPct: null,
      decidedBy: "list-order",
    });
  });

  it("a HEALTHY explicit workspace profile is kept, and recorded as explicit", () => {
    const runtime = resolve(prefs({ [rosterPrefKey(PROJECT_ID)]: '["claude:anth","claude:team5x"]' }), {
      profileOverride: { provider: "claude", name: "anth" },
      headroom: headroom({ "claude:anth": { usedPct: 70 }, "claude:team5x": { usedPct: 5 } }),
    });
    expect(runtime.provider.profileName).toBe("anth");
    expect(runtime.provider.profileClamped).toBe(false);
    expect(runtime.provider.profileSelectionReason).toMatchObject({
      profile: "claude:anth",
      usedPct: 70,
      source: "explicit-profile",
      decidedBy: "explicit",
    });
  });

  it("an EXHAUSTED explicit pool profile falls to the next pool entry, with the reason", () => {
    const runtime = resolve(prefs({ [rosterPrefKey(PROJECT_ID)]: '["claude:anth","claude:team5x"]' }), {
      profileOverride: { provider: "claude", name: "anth" },
      headroom: headroom({ "claude:anth": { usedPct: 97 }, "claude:team5x": { usedPct: 5 } }),
    });
    expect(runtime.provider.profileName).toBe("team5x");
    expect(runtime.provider.profileClamped).toBe(true);
    const reason = runtime.provider.profileSelectionReason;
    expect(reason).toMatchObject({ profile: "claude:team5x", decidedBy: "clamped" });
    expect(reason?.candidates).toContainEqual({ id: "claude:anth", usedPct: 97, outcome: "exhausted" });
  });

  it("a ring-cooling profile is skipped, and the record names it as cooling rather than exhausted", () => {
    const runtime = resolve(
      prefs({
        [rosterPrefKey(PROJECT_ID)]: '["claude:anth","claude:team5x"]',
        claude_cooldown_anth: COOLING_UNTIL,
      }),
      {
        profileOverride: { provider: "claude", name: "anth" },
        headroom: headroom({ "claude:anth": { usedPct: 10 }, "claude:team5x": { usedPct: 40 } }),
      },
    );
    expect(runtime.provider.profileName).toBe("team5x");
    const reason = runtime.provider.profileSelectionReason;
    // Cooling outranks the reading: `anth` has the most headroom and is still not usable.
    expect(reason?.candidates).toContainEqual({ id: "claude:anth", usedPct: 10, outcome: "cooling" });
    expect(reason?.profile).toBe("claude:team5x");
  });

  it("records nothing when no profile resolved — 'not recorded' is not 'the default happened'", () => {
    const runtime = resolveProjectRuntimeConfig({
      projectId: PROJECT_ID,
      prefMap: new Map([["provider", "codex"]]),
      nowMs: NOW_MS,
    });
    expect(runtime.provider.profileName).toBeUndefined();
    expect(runtime.provider.profileSelectionReason).toBeNull();
    expect(serializeProfileSelectionReason(null)).toBeNull();
  });
});
