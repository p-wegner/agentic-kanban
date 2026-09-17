import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { preferences } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  clearTrainWindow,
  holdTrainWindow,
  parseTrainWindow,
  readTrainWindow,
  readTrainWindowsFromPrefMap,
  requestTrainWindowRelease,
  sameTrainWindow,
  trainWindowPref,
  writeTrainWindow,
  type PersistedMergeTrainWindow,
} from "../services/merge-train-window-state.js";

const T0 = "2026-08-26T12:00:00.000Z";

function window(overrides: Partial<PersistedMergeTrainWindow> = {}): PersistedMergeTrainWindow {
  return {
    pendingIds: ["ws-a", "ws-b"],
    firstSeenAt: T0,
    lastVerdict: { release: false, reason: "accumulating" },
    lastEvaluatedAt: T0,
    ...overrides,
  };
}

describe("merge-train window state (#1186)", () => {
  it("the pref key is train_window_<projectId>", () => {
    const projectId = randomUUID();
    expect(trainWindowPref.key(projectId)).toBe(`train_window_${projectId}`);
    expect(trainWindowPref.projectIdOf(`train_window_${projectId}`)).toBe(projectId);
  });

  it("write / read / clear round trip", async () => {
    const { db } = createTestDb();
    const projectId = randomUUID();
    expect(await readTrainWindow(projectId, db)).toBeNull();

    const w = window({ heldUntil: "2026-08-26T12:10:00.000Z", releaseRequestedAt: "2026-08-26T12:05:00.000Z" });
    await writeTrainWindow(projectId, w, db);
    expect(await readTrainWindow(projectId, db)).toEqual(w);

    await clearTrainWindow(projectId, db);
    expect(await readTrainWindow(projectId, db)).toBeNull();
    // Clearing an absent window is a no-op, not an error.
    await clearTrainWindow(projectId, db);
  });

  it("readTrainWindowsFromPrefMap restores every project's window and skips garbage", async () => {
    const { db } = createTestDb();
    const p1 = randomUUID();
    const p2 = randomUUID();
    const p3 = randomUUID();
    await writeTrainWindow(p1, window({ pendingIds: ["a"] }), db);
    await writeTrainWindow(p2, window({ pendingIds: ["b", "c"], firstSeenAt: "2026-08-26T11:00:00.000Z" }), db);
    await db.insert(preferences).values({ key: trainWindowPref.key(p3), value: "{not json", updatedAt: T0 });

    const rows = await db.select().from(preferences);
    const restored = readTrainWindowsFromPrefMap(new Map(rows.map((r) => [r.key, r.value])));
    expect([...restored.keys()].sort()).toEqual([p1, p2].sort());
    expect(restored.get(p2)?.firstSeenAt).toBe("2026-08-26T11:00:00.000Z");
  });

  describe("parseTrainWindow is defensive", () => {
    it("rejects non-JSON, non-objects, and missing/mistyped fields", () => {
      expect(parseTrainWindow(null)).toBeNull();
      expect(parseTrainWindow("")).toBeNull();
      expect(parseTrainWindow("nope")).toBeNull();
      expect(parseTrainWindow("[]")).toBeNull();
      expect(parseTrainWindow(JSON.stringify({ ...window(), pendingIds: "ws-a" }))).toBeNull();
      expect(parseTrainWindow(JSON.stringify({ ...window(), pendingIds: [1, 2] }))).toBeNull();
      expect(parseTrainWindow(JSON.stringify({ ...window(), firstSeenAt: "yesterday" }))).toBeNull();
      expect(parseTrainWindow(JSON.stringify({ ...window(), lastVerdict: { release: true, reason: "accumulating" } }))).toBeNull();
      expect(parseTrainWindow(JSON.stringify({ ...window(), lastVerdict: { release: false, reason: "made_up" } }))).toBeNull();
    });

    it("drops an invalid optional control rather than failing the whole record", () => {
      const parsed = parseTrainWindow(JSON.stringify({ ...window(), heldUntil: "soon", releaseRequestedAt: 42 }));
      expect(parsed).toEqual(window());
    });

    it("accepts every reason the verdict can carry", () => {
      for (const reason of ["max_size", "max_wait", "gate_busy_grace_elapsed", "operator_release"] as const) {
        expect(parseTrainWindow(JSON.stringify(window({ lastVerdict: { release: true, reason } })))?.lastVerdict.reason).toBe(reason);
      }
      for (const reason of ["accumulating", "gate_busy", "held", "live_train"] as const) {
        expect(parseTrainWindow(JSON.stringify(window({ lastVerdict: { release: false, reason } })))?.lastVerdict.reason).toBe(reason);
      }
    });
  });

  describe("sameTrainWindow", () => {
    it("is structural, order-sensitive on members, and treats absent controls as equal to undefined", () => {
      expect(sameTrainWindow(window(), window())).toBe(true);
      expect(sameTrainWindow(window(), window({ pendingIds: ["ws-b", "ws-a"] }))).toBe(false);
      expect(sameTrainWindow(window(), window({ lastVerdict: { release: false, reason: "gate_busy" } }))).toBe(false);
      expect(sameTrainWindow(window(), window({ heldUntil: T0 }))).toBe(false);
      expect(sameTrainWindow(window({ heldUntil: undefined }), window())).toBe(true);
      expect(sameTrainWindow(null, null)).toBe(true);
      expect(sameTrainWindow(null, window())).toBe(false);
    });
  });

  describe("requestTrainWindowRelease", () => {
    it("stamps releaseRequestedAt on an open window", async () => {
      const { db } = createTestDb();
      const projectId = randomUUID();
      await writeTrainWindow(projectId, window(), db);
      const t1 = "2026-08-26T12:01:00.000Z";
      const next = await requestTrainWindowRelease(projectId, db, t1);
      expect(next?.releaseRequestedAt).toBe(t1);
      expect((await readTrainWindow(projectId, db))?.releaseRequestedAt).toBe(t1);
    });

    it("returns null when there is no open window, and for a control-only (empty) record", async () => {
      const { db } = createTestDb();
      const projectId = randomUUID();
      expect(await requestTrainWindowRelease(projectId, db, T0)).toBeNull();
      await writeTrainWindow(projectId, window({ pendingIds: [] }), db);
      expect(await requestTrainWindowRelease(projectId, db, T0)).toBeNull();
      expect((await readTrainWindow(projectId, db))?.releaseRequestedAt).toBeUndefined();
    });
  });

  describe("holdTrainWindow", () => {
    it("sets heldUntil = now + minutes on an open window", async () => {
      const { db } = createTestDb();
      const projectId = randomUUID();
      await writeTrainWindow(projectId, window(), db);
      const next = await holdTrainWindow(projectId, 15, db, T0);
      expect(next?.heldUntil).toBe("2026-08-26T12:15:00.000Z");
      expect(next?.pendingIds).toEqual(["ws-a", "ws-b"]);
      expect((await readTrainWindow(projectId, db))?.heldUntil).toBe("2026-08-26T12:15:00.000Z");
    });

    it("with no open window creates a control-only record whose verdict is held", async () => {
      const { db } = createTestDb();
      const projectId = randomUUID();
      const next = await holdTrainWindow(projectId, 5, db, T0);
      expect(next).toEqual({
        pendingIds: [],
        firstSeenAt: T0,
        lastVerdict: { release: false, reason: "held" },
        lastEvaluatedAt: T0,
        heldUntil: "2026-08-26T12:05:00.000Z",
      });
    });

    it("minutes 0 clears the hold on an open window and keeps the rest", async () => {
      const { db } = createTestDb();
      const projectId = randomUUID();
      await writeTrainWindow(projectId, window({ heldUntil: "2026-08-26T12:15:00.000Z", releaseRequestedAt: T0 }), db);
      const next = await holdTrainWindow(projectId, 0, db, T0);
      expect(next).toEqual(window({ releaseRequestedAt: T0 }));
      expect((await readTrainWindow(projectId, db))?.heldUntil).toBeUndefined();
    });

    it("minutes 0 deletes a control-only record entirely, and is a no-op with no record", async () => {
      const { db } = createTestDb();
      const projectId = randomUUID();
      expect(await holdTrainWindow(projectId, 0, db, T0)).toBeNull();
      await holdTrainWindow(projectId, 5, db, T0);
      expect(await holdTrainWindow(projectId, 0, db, T0)).toBeNull();
      expect(await readTrainWindow(projectId, db)).toBeNull();
    });
  });
});
