/**
 * #986 — rotation's profile-pref write + Bullseye retargets are ONE transaction.
 *
 * Rotation legitimately bypasses the #903 write-time divergence guard (it writes
 * the `<provider>_profile` pref via raw setPreference), then retargets every
 * stored Bullseye policy pinning the exhausted profile. Before #986 those were
 * sequential independent writes: a crash between the profile write and the
 * retargets would leave EXACTLY the provider/Bullseye divergence the #903 guard
 * exists to prevent — silently, since nothing re-checks after the fact.
 *
 * So a failure anywhere in the retarget phase must roll back the profile-pref
 * write (and any already-applied retargets) — all-or-nothing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { PREF_CLAUDE_SUBSCRIPTION_RING, PREF_CLAUDE_PROFILE } from "../constants/preference-keys.js";

// Controls for the mocked setPreference: fail the Nth write to a
// `board_strategy_*` key (1-based). -1 = never fail. vi.hoisted because the
// vi.mock factory is hoisted above module scope.
const failure = vi.hoisted(() => ({ failOnStrategyWrite: -1, strategyWrites: 0 }));

vi.mock("../repositories/preferences.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/preferences.repository.js")>();
  return {
    ...actual,
    setPreference: async (key: string, value: string, database?: Parameters<typeof actual.setPreference>[2]) => {
      if (key.startsWith("board_strategy_")) {
        failure.strategyWrites += 1;
        if (failure.strategyWrites === failure.failOnStrategyWrite) {
          throw new Error("simulated crash mid-retarget (#986)");
        }
      }
      return actual.setPreference(key, value, database);
    },
  };
});

// Import AFTER the mock so the ring module binds the wrapped setPreference.
const { rotateClaudeSubscription } = await import("../services/claude-subscription-ring.js");
const { setPreferences, getPreference, getAllPreferences } = await import("../repositories/preferences.repository.js");

const now = new Date("2026-07-02T12:00:00Z");
const RING = JSON.stringify([{ profile: "max1" }, { profile: "max2" }]);

function bullseye(profileName: string): string {
  return JSON.stringify({
    version: 1,
    providerPolicies: [
      { id: "p1", provider: "claude", profileName, label: `Claude ${profileName}`, mode: "fill", headroomPct: 0, notes: "" },
    ],
  });
}

async function buildPrefMap(database: Parameters<typeof getAllPreferences>[0]) {
  const rows = await getAllPreferences(database);
  return new Map(rows.map((r) => [r.key, r.value]));
}

describe("rotateRing — transactional profile+Bullseye retarget (#986)", () => {
  const { db: database } = createTestDb();
  let projectA: string;
  let projectB: string;

  beforeEach(async () => {
    failure.failOnStrategyWrite = -1;
    failure.strategyWrites = 0;
    projectA = randomUUID();
    projectB = randomUUID();
    await setPreferences([
      { key: "activeProjectId", value: projectA },
      { key: PREF_CLAUDE_SUBSCRIPTION_RING, value: RING },
      { key: PREF_CLAUDE_PROFILE, value: "max1" },
      { key: "provider", value: "claude" },
      // TWO Bullseyes pin the exhausted profile, so we can fail the SECOND
      // retarget — after the profile pref AND the first retarget already wrote.
      { key: `board_strategy_${projectA}`, value: bullseye("max1") },
      { key: `board_strategy_${projectB}`, value: bullseye("max1") },
    ], database);
  });

  it("rolls back the profile-pref write (and earlier retargets) when a retarget fails mid-way", async () => {
    failure.failOnStrategyWrite = 2;
    const prefMap = await buildPrefMap(database);

    await expect(
      rotateClaudeSubscription(database, prefMap, "max1", null, now),
    ).rejects.toThrow(/simulated crash mid-retarget/);

    // The profile pref rolled back — no silent provider/Bullseye divergence.
    expect(await getPreference(PREF_CLAUDE_PROFILE, database)).toBe("max1");
    // Both Bullseyes still pin the original profile (the first retarget,
    // although executed before the crash, rolled back with the transaction).
    expect(await getPreference(`board_strategy_${projectA}`, database)).toBe(bullseye("max1"));
    expect(await getPreference(`board_strategy_${projectB}`, database)).toBe(bullseye("max1"));
    // The caller's in-memory prefMap was never advanced past the DB state.
    expect(prefMap.get(PREF_CLAUDE_PROFILE)).toBe("max1");
    expect(prefMap.get(`board_strategy_${projectA}`)).toBe(bullseye("max1"));
    expect(prefMap.get(`board_strategy_${projectB}`)).toBe(bullseye("max1"));
  });

  it("commits profile pref and all retargets together when nothing fails", async () => {
    const prefMap = await buildPrefMap(database);
    const rotation = await rotateClaudeSubscription(database, prefMap, "max1", null, now);

    expect(rotation.rotated).toBe(true);
    expect(rotation.toProfile).toBe("max2");
    expect(await getPreference(PREF_CLAUDE_PROFILE, database)).toBe("max2");
    for (const projectId of [projectA, projectB]) {
      const strategy = JSON.parse((await getPreference(`board_strategy_${projectId}`, database))!) as {
        providerPolicies: Array<{ profileName: string }>;
      };
      expect(strategy.providerPolicies[0].profileName).toBe("max2");
      expect(prefMap.get(`board_strategy_${projectId}`)).toBe(await getPreference(`board_strategy_${projectId}`, database));
    }
    expect(prefMap.get(PREF_CLAUDE_PROFILE)).toBe("max2");
  });
});
