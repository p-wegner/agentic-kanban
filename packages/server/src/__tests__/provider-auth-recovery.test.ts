// @covers agents.authFailure.rotation [recovery, db]
//
// #430 step 2: rotate off a dead login. The ring already existed and already worked — it was
// simply never consulted for this failure, because the only thing that triggered it was quota
// exhaustion. So these tests are about the TRIGGER and about the states where rotation cannot
// help, which is where the step-3 breaker has to take over.
import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  const schemaMod = await import("@agentic-kanban/shared/schema");
  const { db } = createTestDb();
  return {
    db, writeDb: db, rawClient: undefined, rawWriteClient: undefined, schema: schemaMod,
    withDbRetry: <T>(fn: () => Promise<T>) => fn(),
    withTransaction: <T>(database: { transaction: (fn: unknown) => Promise<T> }, fn: unknown) => database.transaction(fn),
  };
});

import { preferences } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { handleProviderAuthFailure, applyAuthFailureRecovery, AUTH_FAILURE_COOLDOWN_MS } from "../services/provider-auth-recovery.js";
import { writeProfileFailure } from "../services/agent-profile-failure-record.js";

const EXPIRED = "Failed to authenticate: OAuth session expired and could not be refreshed";

async function setPref(key: string, value: string) {
  const now = new Date().toISOString();
  await db.insert(preferences).values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: preferences.key, set: { value, updatedAt: now } });
}

async function readPref(key: string): Promise<string | undefined> {
  const rows = await db.select().from(preferences).where(eq(preferences.key, key)).limit(1);
  return rows[0]?.value;
}

async function seedRing() {
  await setPref("claude_subscription_ring", JSON.stringify([
    { profile: "anth", settingsProfile: "anth" },
    { profile: "spare", settingsProfile: "spare" },
  ]));
  await setPref("claude_profile", "anth");
  await setPref("claude_subscription_rotation", "true");
}

describe("handleProviderAuthFailure (#430 step 2)", () => {
  it("rotates to the next subscription on the live #430 string", async () => {
    await seedRing();
    const outcome = await handleProviderAuthFailure(db, { provider: "claude", profileName: "anth", errorText: EXPIRED });
    expect(outcome.failure?.kind).toBe("oauth-expired");
    expect(outcome.rotated).toBe(true);
    expect(outcome.toProfile).toBe("spare");
    expect(await readPref("claude_profile")).toBe("spare");
  });

  it("cools the dead profile for a DAY, not for a quota window", async () => {
    // Nothing about an expired credential changes on a timer, so the quota path's minutes would
    // just rotate back into the same failure.
    await seedRing();
    const now = new Date("2026-08-12T10:00:00.000Z");
    await handleProviderAuthFailure(db, { provider: "claude", profileName: "anth", errorText: EXPIRED, now });
    const cooldown = await readPref("claude_cooldown_anth");
    expect(Date.parse(cooldown!) - now.getTime()).toBe(AUTH_FAILURE_COOLDOWN_MS);
  });

  it("does NOT rotate on a transient failure", async () => {
    // Misclassifying a transient as terminal would end a run that would have recovered — a worse
    // outcome than the retry loop this is meant to stop.
    await seedRing();
    const outcome = await handleProviderAuthFailure(db, {
      provider: "claude", profileName: "anth", errorText: "connect ETIMEDOUT 1.2.3.4:443",
    });
    expect(outcome.failure).toBeNull();
    expect(outcome.rotated).toBe(false);
    expect(await readPref("claude_profile")).toBe("anth");
  });

  it("reports honestly when the ring cannot rotate", async () => {
    // The measured loop ran in exactly this state — no ring — which is why the breaker exists.
    await setPref("claude_subscription_ring", "[]");
    await setPref("claude_profile", "solo");
    const outcome = await handleProviderAuthFailure(db, { provider: "claude", profileName: "solo", errorText: EXPIRED });
    expect(outcome.failure?.kind).toBe("oauth-expired");
    expect(outcome.rotated).toBe(false);
    expect(outcome.remedy).toContain("Could not rotate");
    expect(outcome.remedy).toContain("re-authenticate");
  });

  it("does not rotate when rotation is explicitly disabled", async () => {
    await seedRing();
    await setPref("claude_subscription_rotation", "false");
    const outcome = await handleProviderAuthFailure(db, { provider: "claude", profileName: "anth", errorText: EXPIRED });
    expect(outcome.rotated).toBe(false);
    expect(await readPref("claude_profile")).toBe("anth");
  });
});

describe("applyAuthFailureRecovery — who owns the resting status (#430 step 3)", () => {
  it("leaves the workspace to the ordinary idle path on a transient failure", async () => {
    const statuses: string[] = [];
    const handled = await applyAuthFailureRecovery(db, {
      provider: "claude", profileName: "fresh-a", errorText: "socket hang up",
      workspaceId: "ws-1", setWorkspaceStatus: async (s) => { statuses.push(s); },
    });
    expect(handled).toBe(false);
    expect(statuses).toEqual([]);
  });

  it("still leaves it idle on a FIRST auth failure — rotation may have fixed it", async () => {
    await seedRing();
    const statuses: string[] = [];
    const handled = await applyAuthFailureRecovery(db, {
      provider: "claude", profileName: "anth", errorText: EXPIRED,
      workspaceId: "ws-2", setWorkspaceStatus: async (s) => { statuses.push(s); },
    });
    expect(handled).toBe(false);
    expect(statuses).toEqual([]);
  });

  it("parks the workspace BLOCKED once the profile's breaker is open", async () => {
    // `idle` is what every automation path reads as "start this", so parking blocked IS the fix:
    // it is the one status nothing auto-starts.
    await seedRing();
    await writeProfileFailure(db, {
      at: new Date().toISOString(), provider: "claude", profileName: "dead",
      summary: EXPIRED, consecutive: 3,
    });
    const statuses: string[] = [];
    const handled = await applyAuthFailureRecovery(db, {
      provider: "claude", profileName: "dead", errorText: EXPIRED,
      workspaceId: "ws-3", setWorkspaceStatus: async (s) => { statuses.push(s); },
    });
    expect(handled).toBe(true);
    expect(statuses).toEqual(["blocked"]);
  });
});
