/**
 * #973 — auth-rotation ring vs the #903 provider-divergence guard.
 *
 * Rotation is a LEGITIMATE writer of the global `<provider>_profile` pref, but a
 * Strategy Bullseye policy that pins the exhausted profile BY NAME would
 * (a) manufacture exactly the divergence the #903 write-time guard forbids — a
 * later legitimate settings save then 422s on drift it didn't cause — and
 * (b) keep selecting the cooled-down login for Bullseye-driven launches
 * (`selectProviderFromStrategy` reads the policy's `profileName`, not the pref).
 *
 * So `rotateRing` must retarget every stored Bullseye policy that references the
 * rotated-from profile for its provider, in the same step as the pref write — the
 * "write both sides so the projected map is self-consistent" shape the config
 * import route uses.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { setPreferences, getPreference, getAllPreferences } from "../repositories/preferences.repository.js";
import { rotateClaudeSubscription } from "../services/claude-subscription-ring.js";
import { resolveProviderDivergence } from "../services/project-runtime-config.service.js";
import { PREF_CLAUDE_SUBSCRIPTION_RING, PREF_CLAUDE_PROFILE } from "../constants/preference-keys.js";

const now = new Date("2026-07-02T12:00:00Z");
const RING = JSON.stringify([{ profile: "max1" }, { profile: "max2" }]);

function bullseyeWithPolicies(policies: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    version: 1,
    backlogFloor: 7,
    providerPolicies: policies,
  });
}

async function buildPrefMap(database: Parameters<typeof getAllPreferences>[0]) {
  const rows = await getAllPreferences(database);
  return new Map(rows.map((r) => [r.key, r.value]));
}

describe("rotateRing — Bullseye coherence (#973)", () => {
  const { db: database } = createTestDb();
  let projectId: string;

  beforeEach(async () => {
    projectId = randomUUID();
    await database.insert(schema.projects).values({
      id: projectId,
      name: "rotation-coherence-test",
      repoPath: "/tmp/rotation-coherence-test",
      repoName: "rotation-coherence-test",
      defaultBranch: "main",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    await setPreferences([
      { key: "activeProjectId", value: projectId },
      { key: PREF_CLAUDE_SUBSCRIPTION_RING, value: RING },
      { key: PREF_CLAUDE_PROFILE, value: "max1" },
      { key: "provider", value: "claude" },
      {
        key: `board_strategy_${projectId}`,
        value: bullseyeWithPolicies([
          { id: "p1", provider: "claude", profileName: "max1", label: "Claude max1", mode: "fill", headroomPct: 0, notes: "" },
          { id: "p2", provider: "claude", profileName: "other", label: "Claude other", mode: "fallback-only", headroomPct: 20, notes: "" },
          { id: "p3", provider: "codex", profileName: "max1", label: "Codex max1", mode: "throttle", headroomPct: 20, notes: "" },
        ]),
      },
    ], database);
  });

  it("retargets Bullseye policies pinning the rotated-from profile, so the projected map stays self-consistent", async () => {
    const prefMap = await buildPrefMap(database);
    const rotation = await rotateClaudeSubscription(database, prefMap, "max1", null, now);

    expect(rotation.rotated).toBe(true);
    expect(rotation.toProfile).toBe("max2");
    expect(await getPreference(PREF_CLAUDE_PROFILE, database)).toBe("max2");

    const strategyRaw = await getPreference(`board_strategy_${projectId}`, database);
    const strategy = JSON.parse(strategyRaw!) as { backlogFloor: number; providerPolicies: Array<{ id: string; provider: string; profileName: string }> };

    // The claude policy pinning the exhausted profile follows the rotation …
    expect(strategy.providerPolicies.find((p) => p.id === "p1")?.profileName).toBe("max2");
    // … while a policy on another profile and another provider's policy are untouched.
    expect(strategy.providerPolicies.find((p) => p.id === "p2")?.profileName).toBe("other");
    expect(strategy.providerPolicies.find((p) => p.id === "p3")?.profileName).toBe("max1");
    // Unrelated fields of the stored Bullseye survive the surgical rewrite.
    expect(strategy.backlogFloor).toBe(7);

    // The in-memory prefMap the caller keeps using is updated too.
    expect(prefMap.get(PREF_CLAUDE_PROFILE)).toBe("max2");
    expect(prefMap.get(`board_strategy_${projectId}`)).toBe(strategyRaw);

    // The invariant the #903 guard enforces holds AFTER rotation: no divergence,
    // so a later legitimate settings save is not 422'd on drift it didn't cause.
    const after = await buildPrefMap(database);
    expect(resolveProviderDivergence(after, projectId).diverged).toBe(false);
  });

  it("still rotates cleanly when no Bullseye references the profile", async () => {
    await setPreferences([
      { key: `board_strategy_${projectId}`, value: bullseyeWithPolicies([
        { id: "p1", provider: "claude", profileName: "other", label: "Claude other", mode: "fill", headroomPct: 0, notes: "" },
      ]) },
    ], database);
    const prefMap = await buildPrefMap(database);
    const rotation = await rotateClaudeSubscription(database, prefMap, "max1", null, now);
    expect(rotation.rotated).toBe(true);
    const strategy = JSON.parse((await getPreference(`board_strategy_${projectId}`, database))!) as { providerPolicies: Array<{ profileName: string }> };
    expect(strategy.providerPolicies[0].profileName).toBe("other");
  });

  it("ignores an unparseable stored Bullseye instead of failing the rotation", async () => {
    await setPreferences([
      { key: `board_strategy_${projectId}`, value: "not json {" },
    ], database);
    const prefMap = await buildPrefMap(database);
    const rotation = await rotateClaudeSubscription(database, prefMap, "max1", null, now);
    expect(rotation.rotated).toBe(true);
    expect(await getPreference(PREF_CLAUDE_PROFILE, database)).toBe("max2");
    expect(await getPreference(`board_strategy_${projectId}`, database)).toBe("not json {");
  });
});
