import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "./helpers/test-db.js";
import {
  getAllPreferencesCached,
  invalidatePreferencesCache,
  setPreference,
} from "../repositories/preferences.repository.js";
import { setPreferenceChecked } from "@agentic-kanban/shared/lib/checked-preference-write";
import type { Database } from "../db/index.js";

/** Minimal fake database whose select().from() calls are countable. */
function fakeDb(rows: () => { key: string; value: string; updatedAt: string }[]) {
  const selectSpy = vi.fn(() => ({ from: async () => rows() }));
  return { database: { select: selectSpy } as unknown as Database, selectSpy };
}

describe("short-TTL preferences cache (#402)", () => {
  it("serves repeated reads within the TTL from ONE underlying query (injected now)", async () => {
    invalidatePreferencesCache();
    const { database, selectSpy } = fakeDb(() => [
      { key: "a", value: "1", updatedAt: "2026-01-01T00:00:00.000Z" },
    ]);

    const first = await getAllPreferencesCached(database, { nowMs: 0 });
    const second = await getAllPreferencesCached(database, { nowMs: 1_999 });

    expect(selectSpy).toHaveBeenCalledTimes(1);
    expect(second).toBe(first); // same cached array, not a re-read
    expect(second.map((r) => r.key)).toEqual(["a"]);
  });

  it("refetches once the injected now crosses the TTL boundary", async () => {
    invalidatePreferencesCache();
    const { database, selectSpy } = fakeDb(() => [
      { key: "a", value: "1", updatedAt: "2026-01-01T00:00:00.000Z" },
    ]);

    await getAllPreferencesCached(database, { nowMs: 0 });
    await getAllPreferencesCached(database, { nowMs: 2_000 }); // TTL is 2000ms — exactly expired

    expect(selectSpy).toHaveBeenCalledTimes(2);
  });

  it("is keyed per database handle — one db's cache never serves another's rows", async () => {
    invalidatePreferencesCache();
    const a = fakeDb(() => [{ key: "from-a", value: "1", updatedAt: "x" }]);
    const b = fakeDb(() => [{ key: "from-b", value: "1", updatedAt: "x" }]);

    const rowsA = await getAllPreferencesCached(a.database, { nowMs: 0 });
    const rowsB = await getAllPreferencesCached(b.database, { nowMs: 0 });

    expect(rowsA.map((r) => r.key)).toEqual(["from-a"]);
    expect(rowsB.map((r) => r.key)).toEqual(["from-b"]);
  });

  it("busts on a repository write (setPreference) even within the TTL", async () => {
    const { db } = createTestDb();

    const before = await getAllPreferencesCached(db);
    expect(before.find((r) => r.key === "cache_probe")).toBeUndefined();

    await setPreference("cache_probe", "fresh", db);

    const after = await getAllPreferencesCached(db);
    expect(after.find((r) => r.key === "cache_probe")?.value).toBe("fresh");
  });

  it("busts on the shared checked write path (setPreferenceChecked → updateSettings/CLI/MCP)", async () => {
    const { db } = createTestDb();

    const before = await getAllPreferencesCached(db);
    expect(before.find((r) => r.key === "checked_probe")).toBeUndefined();

    const result = await setPreferenceChecked(db, [{ key: "checked_probe", value: "checked" }]);
    expect(result.divergence).toBeNull();

    const after = await getAllPreferencesCached(db);
    expect(after.find((r) => r.key === "checked_probe")?.value).toBe("checked");
  });
});
