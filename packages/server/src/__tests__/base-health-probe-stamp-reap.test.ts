/**
 * #1223 — a killed base-branch probe's persisted "started" stamp must not wedge every reprobe
 * for the full 65-minute ceiling with no operator-visible signal that nothing is actually
 * running.
 *
 * Two independent halves:
 *  - `reapStaleBaseHealthProbeStamps` clears every `base_health_probe_started_<projectId>` stamp
 *    on boot, because a freshly-started process cannot possibly own a probe that was already
 *    running before it started — any stamp still on disk belongs to a killed process.
 *  - `isBaseHealthProbeDue` names the stamp's start/expiry on a `probe_in_flight` verdict, so a
 *    caller (the reprobe route, `promote.mjs`) can tell a live probe from a stale claim instead
 *    of reading an unqualified "probe_in_flight".
 */
import { describe, it, expect } from "vitest";
import { createTestDb } from "./helpers/test-db.js";
import { getPreference, setPreference } from "../repositories/preferences.repository.js";
import {
  reapStaleBaseHealthProbeStamps,
  isBaseHealthProbeDue,
} from "../services/base-branch-health-reprobe.service.js";
import { baseHealthProbeStartPrefKey, PROBE_MAX_DURATION_MS } from "../services/base-branch-health.service.js";

const NOW = Date.parse("2026-09-22T07:09:14.000Z");
const iso = (deltaMs: number) => new Date(NOW + deltaMs).toISOString();

describe("reapStaleBaseHealthProbeStamps (#1223)", () => {
  it("clears every persisted probe-started stamp, regardless of project", async () => {
    const { db } = createTestDb();
    await setPreference(baseHealthProbeStartPrefKey("p1"), iso(-5 * 60_000), db);
    await setPreference(baseHealthProbeStartPrefKey("p2"), iso(-60_000), db);
    // An unrelated pref must survive untouched.
    await setPreference("auto_monitor", "false", db);

    const cleared = await reapStaleBaseHealthProbeStamps(db);

    expect(cleared.sort()).toEqual([baseHealthProbeStartPrefKey("p1"), baseHealthProbeStartPrefKey("p2")].sort());
    expect(await getPreference(baseHealthProbeStartPrefKey("p1"), db)).toBe("");
    expect(await getPreference(baseHealthProbeStartPrefKey("p2"), db)).toBe("");
    expect(await getPreference("auto_monitor", db)).toBe("false");
  });

  it("is a no-op when nothing is stamped — idempotent, no error", async () => {
    const { db } = createTestDb();
    const cleared = await reapStaleBaseHealthProbeStamps(db);
    expect(cleared).toEqual([]);
  });

  it("does not re-clear an already-empty stamp (only genuinely stale ones are reported)", async () => {
    const { db } = createTestDb();
    await setPreference(baseHealthProbeStartPrefKey("p1"), "", db);
    const cleared = await reapStaleBaseHealthProbeStamps(db);
    expect(cleared).toEqual([]);
  });
});

describe("isBaseHealthProbeDue names the stamp's age/expiry on probe_in_flight (#1223)", () => {
  it("carries startedAt and the PROBE_MAX_DURATION_MS expiry", () => {
    const startedAt = iso(-5 * 60_000);
    const verdict = isBaseHealthProbeDue({
      nowMs: NOW,
      intervalMs: 30 * 60_000,
      probeStartedAt: startedAt,
    });

    expect(verdict).toEqual({
      due: false,
      reason: "probe_in_flight",
      probeInFlightSince: {
        startedAt,
        expiresAt: new Date(Date.parse(startedAt) + PROBE_MAX_DURATION_MS).toISOString(),
      },
    });
  });

  it("omits probeInFlightSince for every other reason", () => {
    const verdict = isBaseHealthProbeDue({ nowMs: NOW, intervalMs: 30 * 60_000, gateBusy: true });
    expect(verdict.probeInFlightSince).toBeUndefined();
  });
});
