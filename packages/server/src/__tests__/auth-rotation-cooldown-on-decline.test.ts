/**
 * #1048 item 2 — a usage-limit exit that DECLINES to rotate must still record the
 * exhausted profile where the next start reads it.
 *
 * Before this fix, `rotateRing` only stamped the `<provider>_cooldown_<profile>` pref
 * once it had already passed both early-return checks (no ring configured / rotation
 * disabled), so those two decline paths wrote NOTHING — a usage-limit exit that hit
 * either one left the board with no record that the profile was exhausted, and the
 * very next start (a default relaunch, the monitor, the UI button) walked straight
 * back into the same account. Reproduces the #1038 symptom described in the ticket:
 * "set the workspace blocked, wrote no cooldown key, and left claude_profile unchanged".
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "./helpers/test-db.js";
import { rotateClaudeSubscription } from "../services/claude-subscription-ring.js";
import { PREF_CLAUDE_SUBSCRIPTION_RING, PREF_CLAUDE_PROFILE } from "../constants/preference-keys.js";
import { getPreference, setPreferences, getAllPreferences } from "../repositories/preferences.repository.js";

const now = new Date("2026-09-05T12:00:00Z");

async function buildPrefMap(database: Parameters<typeof getAllPreferences>[0]) {
  const rows = await getAllPreferences(database);
  return new Map(rows.map((r) => [r.key, r.value]));
}

describe("rotateRing — stamps the exhausted profile's cooldown even when it declines to rotate", () => {
  let database: ReturnType<typeof createTestDb>["db"];

  beforeEach(async () => {
    ({ db: database } = createTestDb());
    await setPreferences([{ key: PREF_CLAUDE_PROFILE, value: "andrena_team_5x_2" }], database);
  });

  it("no ring configured: still stamps the cooldown", async () => {
    const prefMap = await buildPrefMap(database);

    const rotation = await rotateClaudeSubscription(database, prefMap, "andrena_team_5x_2", null, now);

    expect(rotation.rotated).toBe(false);
    expect(rotation.reason).toMatch(/no ring configured/);
    const stamped = await getPreference("claude_cooldown_andrena_team_5x_2", database);
    expect(stamped).not.toBeNull();
    expect(Date.parse(stamped!)).toBeGreaterThan(now.getTime());
    expect(prefMap.get("claude_cooldown_andrena_team_5x_2")).toBe(stamped);
    // Declining to rotate must not touch the selected profile.
    expect(await getPreference(PREF_CLAUDE_PROFILE, database)).toBe("andrena_team_5x_2");
  });

  it("rotation disabled: still stamps the cooldown", async () => {
    await setPreferences([
      { key: PREF_CLAUDE_SUBSCRIPTION_RING, value: JSON.stringify([{ profile: "andrena_team_5x_2" }, { profile: "andrena_team_5x" }]) },
      { key: "claude_subscription_rotation", value: "false" },
    ], database);
    const prefMap = await buildPrefMap(database);

    const rotation = await rotateClaudeSubscription(database, prefMap, "andrena_team_5x_2", null, now);

    expect(rotation.rotated).toBe(false);
    expect(rotation.reason).toBe("rotation disabled");
    const stamped = await getPreference("claude_cooldown_andrena_team_5x_2", database);
    expect(stamped).not.toBeNull();
    expect(prefMap.get("claude_cooldown_andrena_team_5x_2")).toBe(stamped);
  });

  it("every login cooling: still stamps (already covered, kept as a lock-in)", async () => {
    await setPreferences([
      { key: PREF_CLAUDE_SUBSCRIPTION_RING, value: JSON.stringify([{ profile: "andrena_team_5x_2" }, { profile: "andrena_team_5x" }]) },
      { key: "claude_cooldown_andrena_team_5x", value: "2099-01-01T00:00:00.000Z" },
    ], database);
    const prefMap = await buildPrefMap(database);

    const rotation = await rotateClaudeSubscription(database, prefMap, "andrena_team_5x_2", null, now);

    expect(rotation.rotated).toBe(false);
    expect(rotation.reason).toMatch(/cooled down/);
    expect(await getPreference("claude_cooldown_andrena_team_5x_2", database)).not.toBeNull();
  });
});
