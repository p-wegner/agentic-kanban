/**
 * The profile ROSTER (#1025) through `resolveProjectRuntimeConfig` — the seam every launch
 * path actually goes through, the same one `project-profile-allowlist.test.ts` uses for the
 * flat allowlist (which stays green, unchanged, and is the proof that nothing regressed).
 *
 * What is worth pinning here is what a refactor of the precedence chain could silently
 * break: that a `forbidden` profile is REFUSED rather than swapped even when the request is
 * an explicit per-workspace override, that the reserve is not reachable without a grant,
 * that the pool is ordered by headroom, and that a board where nobody declared a role
 * behaves exactly as it did before this existed.
 */
import { describe, expect, it } from "vitest";
import {
  allowedProfilesPrefKey,
  resolveProjectRuntimeConfig,
  reserveAllowedPrefKey,
  rosterPrefKey,
} from "../services/project-runtime-config.service.js";
import type { ProfileHeadroom, RosterEntry } from "@agentic-kanban/shared/lib/profile-allowlist";

const PROJECT_ID = "11111111-2222-3333-4444-555555555555";
const NOW_MS = Date.parse("2026-09-04T09:00:00.000Z");
const COOLING = new Date(NOW_MS + 60 * 60 * 1000).toISOString();

const GLOBAL: RosterEntry[] = [
  { provider: "claude", name: "anth", role: "pool" },
  { provider: "claude", name: "team5x", role: "pool" },
  { provider: "claude", name: "privat", role: "reserve" },
  { provider: "claude", name: "training", role: "forbidden" },
];

function prefs(entries: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries({ provider: "claude", ...entries }));
}

function headroom(pairs: Record<string, ProfileHeadroom>): Map<string, ProfileHeadroom> {
  return new Map(Object.entries(pairs));
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

describe("per-project profile roster", () => {
  it("changes nothing when no profile declares a role", () => {
    const runtime = resolveProjectRuntimeConfig({
      projectId: PROJECT_ID,
      prefMap: prefs({ claude_profile: "whatever" }),
      nowMs: NOW_MS,
      globalRoster: [{ provider: "claude", name: "whatever", role: "pool" }],
    });
    expect(runtime.provider.roster.restricted).toBe(false);
    expect(runtime.provider.profileName).toBe("whatever");
    expect(runtime.provider.profileHold).toBeNull();
    expect(runtime.provider.profileClamped).toBe(false);
    expect(runtime.provider.reserveUsed).toBe(false);
  });

  it("REFUSES a forbidden profile requested as an explicit workspace override", () => {
    // The refusal, not a clamp: substituting `anth` here would launch work on an account
    // the operator did not choose, while honouring `training` would spend an account that
    // must never see this work. Both are wrong, so the launch stops.
    const runtime = resolve(prefs(), { profileOverride: { provider: "claude", name: "training" } });
    expect(runtime.provider.profileRefused).toBe(true);
    expect(runtime.provider.profileHold).toContain("forbidden");
    expect(runtime.provider.profileClamped).toBe(false);
  });

  it("REFUSES a forbidden profile arriving via a ring rewrite of claude_profile", () => {
    const runtime = resolve(prefs({ claude_profile: "training" }));
    expect(runtime.provider.profileRefused).toBe(true);
  });

  it("a project roster may narrow a pool profile to forbidden", () => {
    const runtime = resolve(
      prefs({ [rosterPrefKey(PROJECT_ID)]: '["claude:anth:forbidden","claude:team5x"]' }),
      { profileOverride: { provider: "claude", name: "anth" } },
    );
    expect(runtime.provider.profileRefused).toBe(true);
  });

  it("a project roster may NOT widen a globally forbidden profile", () => {
    const runtime = resolve(
      prefs({ [rosterPrefKey(PROJECT_ID)]: '["claude:training:pool"]' }),
      { profileOverride: { provider: "claude", name: "training" } },
    );
    expect(runtime.provider.roster.entries).toMatchObject([
      { provider: "claude", name: "training", role: "forbidden" },
    ]);
    expect(runtime.provider.profileRefused).toBe(true);
  });

  it("orders the pool by remaining 5-hour headroom when it has to choose", () => {
    // `anth` is over the threshold, so a choice is forced and the most-headroom profile wins.
    const runtime = resolve(prefs({ claude_profile: "anth" }), {
      headroom: headroom({ "claude:anth": { usedPct: 95 }, "claude:team5x": { usedPct: 12 } }),
    });
    expect(runtime.provider.profileName).toBe("team5x");
    expect(runtime.provider.poolOrder).toEqual(["claude:team5x", "claude:anth"]);
  });

  it("does NOT preempt a healthy explicit choice — that is #1026, not this", () => {
    // Ordering decides who is picked when the roster has to pick, not whether to move off a
    // profile that is still fine. Rotating a healthy launch onto a fresher account is
    // predictive rotation and is deliberately out of scope here.
    const runtime = resolve(prefs({ claude_profile: "anth" }), {
      headroom: headroom({ "claude:anth": { usedPct: 70 }, "claude:team5x": { usedPct: 5 } }),
    });
    expect(runtime.provider.profileName).toBe("anth");
    expect(runtime.provider.profileClamped).toBe(false);
    expect(runtime.provider.poolOrder).toEqual(["claude:team5x", "claude:anth"]);
  });

  it("an UNKNOWN measurement sorts behind a fresh one and is never read as exhausted", () => {
    const runtime = resolve(prefs({ claude_profile: "anth" }), {
      headroom: headroom({ "claude:anth": { usedPct: null, stale: true }, "claude:team5x": { usedPct: 30 } }),
    });
    expect(runtime.provider.poolOrder).toEqual(["claude:team5x", "claude:anth"]);
    // A stale reading is not exhaustion: `anth` is still the launch profile.
    expect(runtime.provider.profileName).toBe("anth");
    // …and with nothing measured at all, declared order survives.
    const noQuota = resolve(prefs({ claude_profile: "anth" }));
    expect(noQuota.provider.poolOrder).toEqual(["claude:anth", "claude:team5x"]);
  });

  it("HOLDS instead of touching the reserve when no grant permits it", () => {
    const runtime = resolve(prefs({
      claude_profile: "anth",
      claude_cooldown_anth: COOLING,
      claude_cooldown_team5x: COOLING,
    }));
    expect(runtime.provider.profileHold).toContain("reserve is not allowed");
    expect(runtime.provider.reserveUsed).toBe(false);
  });

  it("takes the reserve once the project flag grants it, and says so", () => {
    const runtime = resolve(prefs({
      claude_profile: "anth",
      claude_cooldown_anth: COOLING,
      claude_cooldown_team5x: COOLING,
      [reserveAllowedPrefKey(PROJECT_ID)]: "true",
    }));
    expect(runtime.provider.profileName).toBe("privat");
    expect(runtime.provider.reserveUsed).toBe(true);
    expect(runtime.provider.reserveAllowedReason).toContain("reserve_allowed");
    expect(runtime.provider.reserveNote).toContain("RESERVE");
  });

  it("a ticket tagged reserve:ok is the second grant", () => {
    const runtime = resolve(
      prefs({ claude_profile: "anth", claude_cooldown_anth: COOLING, claude_cooldown_team5x: COOLING }),
      { issueTags: ["reserve:ok"] },
    );
    expect(runtime.provider.reserveUsed).toBe(true);
  });

  it("a fully exhausted CLOSED roster holds exactly like today's allowlist", () => {
    const runtime = resolve(prefs({
      claude_profile: "anth",
      claude_cooldown_anth: COOLING,
      [rosterPrefKey(PROJECT_ID)]: '["claude:anth"]',
    }));
    expect(runtime.provider.profileHold).toContain("cooling");
    expect(runtime.provider.profileName).not.toBe("privat");
  });

  it("reads an existing allowed_profiles value as an all-pool roster (the migration)", () => {
    const runtime = resolve(prefs({
      claude_profile: "personal",
      [allowedProfilesPrefKey(PROJECT_ID)]: JSON.stringify([{ provider: "claude", name: "team5x" }]),
    }));
    expect(runtime.provider.roster.source).toBe("allowed_profiles");
    expect(runtime.provider.roster.entries).toMatchObject([{ provider: "claude", name: "team5x", role: "pool" }]);
    expect(runtime.provider.profileName).toBe("team5x");
    expect(runtime.provider.profileClamped).toBe(true);
  });
});
