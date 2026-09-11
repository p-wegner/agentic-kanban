import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #1099 P2-16: the store mirrors `byView` into localStorage so an anchor/zoom/filter survives
// a page reload. The client package's vitest environment is "node" (no real `localStorage`,
// per the note in boardFilterStore.test.ts) — stub a minimal in-memory implementation so this
// suite can verify the actual read/write round-trip rather than only "doesn't crash without
// storage" (a real risk since the module reads storage once, eagerly, at import time).

function fakeLocalStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
    clear: () => data.clear(),
  };
}

describe("timelineViewStore — localStorage persistence (#1099 P2-16)", () => {
  let storage: ReturnType<typeof fakeLocalStorage>;

  beforeEach(() => {
    vi.resetModules();
    storage = fakeLocalStorage();
    vi.stubGlobal("localStorage", storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes to localStorage when a view's state is set", async () => {
    const { useTimelineViewStore } = await import("./timelineViewStore.js");
    useTimelineViewStore.getState().set("proj-1:timeline", {
      anchor: 100,
      pxPerMs: 0.01,
      scale: "day",
      showCompleted: true,
      activeTypes: ["task", "bug"],
    });
    const raw = storage.getItem("timeline-view-state");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)["proj-1:timeline"]).toEqual({
      anchor: 100,
      pxPerMs: 0.01,
      scale: "day",
      showCompleted: true,
      activeTypes: ["task", "bug"],
    });
  });

  it("restores persisted state on a fresh module load (simulating a page reload)", async () => {
    storage.setItem(
      "timeline-view-state",
      JSON.stringify({
        "proj-1:timeline": { anchor: 42, pxPerMs: 0.5, scale: "week", showCompleted: false, activeTypes: ["task"] },
      }),
    );
    const { useTimelineViewStore } = await import("./timelineViewStore.js");
    expect(useTimelineViewStore.getState().byView["proj-1:timeline"]).toEqual({
      anchor: 42,
      pxPerMs: 0.5,
      scale: "week",
      showCompleted: false,
      activeTypes: ["task"],
    });
  });

  it("starts empty (not throwing) when localStorage holds malformed JSON", async () => {
    storage.setItem("timeline-view-state", "{not json");
    const { useTimelineViewStore } = await import("./timelineViewStore.js");
    expect(useTimelineViewStore.getState().byView).toEqual({});
  });

  it("does not throw when localStorage is unavailable (the real 'node' test environment)", async () => {
    vi.unstubAllGlobals();
    const { useTimelineViewStore } = await import("./timelineViewStore.js");
    expect(() =>
      useTimelineViewStore.getState().set("proj-1:timeline", {
        anchor: 1,
        pxPerMs: 1,
        scale: "day",
        showCompleted: true,
        activeTypes: [],
      }),
    ).not.toThrow();
  });
});
