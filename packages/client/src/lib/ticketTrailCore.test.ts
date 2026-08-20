import { describe, expect, it } from "vitest";
import {
  activeEntry,
  canGoBack,
  canGoForward,
  EMPTY_TRAIL,
  goBack,
  goForward,
  goTo,
  MAX_TRAIL_ENTRIES,
  remove,
  sanitize,
  visit,
  type TrailEntry,
  type TrailState,
} from "./ticketTrailCore.js";

function entry(n: number): TrailEntry {
  return { id: `id-${n}`, number: n, title: `Ticket ${n}` };
}

/** Build a trail by visiting entries in order (so the LAST visited is at front). */
function trailOf(...ns: number[]): TrailState {
  return ns.reduce<TrailState>((s, n) => visit(s, entry(n)), EMPTY_TRAIL);
}

describe("ticketTrailCore.visit", () => {
  it("adds a new ticket to the front and makes it active", () => {
    const s = visit(EMPTY_TRAIL, entry(1));
    expect(s.entries.map((e) => e.id)).toEqual(["id-1"]);
    expect(activeEntry(s)?.id).toBe("id-1");
  });

  it("orders most-recent-first across multiple visits", () => {
    const s = trailOf(1, 2, 3);
    expect(s.entries.map((e) => e.id)).toEqual(["id-3", "id-2", "id-1"]);
    expect(activeEntry(s)?.id).toBe("id-3");
  });

  it("moves a re-visited ticket back to the front (dedupes)", () => {
    const s = visit(trailOf(1, 2, 3), entry(1));
    expect(s.entries.map((e) => e.id)).toEqual(["id-1", "id-3", "id-2"]);
    expect(activeEntry(s)?.id).toBe("id-1");
  });

  it("refreshes the label in place when re-visiting the already-active ticket", () => {
    const base = trailOf(1, 2);
    const renamed = visit(base, { id: "id-2", number: 2, title: "Renamed" });
    expect(renamed.entries.map((e) => e.id)).toEqual(["id-2", "id-1"]);
    expect(renamed.cursor).toBe(0);
    expect(renamed.entries[0].title).toBe("Renamed");
  });

  it("caps the trail at MAX_TRAIL_ENTRIES, dropping the oldest", () => {
    let s = EMPTY_TRAIL;
    for (let i = 0; i < MAX_TRAIL_ENTRIES + 5; i++) s = visit(s, entry(i));
    expect(s.entries).toHaveLength(MAX_TRAIL_ENTRIES);
    // Most recent kept, oldest dropped.
    expect(s.entries[0].id).toBe(`id-${MAX_TRAIL_ENTRIES + 4}`);
    expect(s.entries.some((e) => e.id === "id-0")).toBe(false);
  });
});

describe("ticketTrailCore back/forward", () => {
  it("walks older then newer, preserving the entry order", () => {
    const s = trailOf(1, 2, 3); // front=3 (cursor 0)
    expect(canGoBack(s)).toBe(true);
    expect(canGoForward(s)).toBe(false);

    const back1 = goBack(s); // -> id-2
    expect(activeEntry(back1)?.id).toBe("id-2");
    expect(canGoForward(back1)).toBe(true);

    const back2 = goBack(back1); // -> id-1 (tail)
    expect(activeEntry(back2)?.id).toBe("id-1");
    expect(canGoBack(back2)).toBe(false);

    const fwd = goForward(back2); // -> id-2
    expect(activeEntry(fwd)?.id).toBe("id-2");
  });

  it("does not move past the ends", () => {
    const s = trailOf(1, 2);
    expect(goForward(s)).toBe(s); // already at front
    const atTail = goBack(s);
    expect(goBack(atTail)).toBe(atTail); // already at tail
  });
});

describe("ticketTrailCore.goTo", () => {
  it("activates the requested entry without reordering", () => {
    const s = trailOf(1, 2, 3);
    const jumped = goTo(s, "id-1");
    expect(activeEntry(jumped)?.id).toBe("id-1");
    expect(jumped.entries.map((e) => e.id)).toEqual(["id-3", "id-2", "id-1"]);
  });

  it("is a no-op for an unknown id", () => {
    const s = trailOf(1, 2);
    expect(goTo(s, "nope")).toBe(s);
  });
});

describe("ticketTrailCore.remove", () => {
  it("removing the active ticket falls through to the next-most-recent", () => {
    const s = trailOf(1, 2, 3); // active id-3 (cursor 0)
    const after = remove(s, "id-3");
    expect(after.entries.map((e) => e.id)).toEqual(["id-2", "id-1"]);
    expect(activeEntry(after)?.id).toBe("id-2");
  });

  it("removing a newer background ticket keeps the active ticket active", () => {
    const s = goBack(trailOf(1, 2, 3)); // active id-2 (cursor 1)
    const after = remove(s, "id-3"); // remove the front (newer) one
    expect(activeEntry(after)?.id).toBe("id-2");
    expect(after.entries.map((e) => e.id)).toEqual(["id-2", "id-1"]);
  });

  it("removing the last ticket empties the trail", () => {
    const s = trailOf(7);
    const after = remove(s, "id-7");
    expect(after.entries).toHaveLength(0);
    expect(activeEntry(after)).toBeNull();
    expect(after.cursor).toBe(-1);
  });

  it("is a no-op for an unknown id", () => {
    const s = trailOf(1, 2);
    expect(remove(s, "nope")).toBe(s);
  });
});

describe("ticketTrailCore.sanitize", () => {
  it("recovers an empty trail from junk", () => {
    expect(sanitize(null)).toEqual(EMPTY_TRAIL);
    expect(sanitize(42)).toEqual(EMPTY_TRAIL);
    expect(sanitize({})).toEqual(EMPTY_TRAIL);
    expect(sanitize({ entries: "x" })).toEqual(EMPTY_TRAIL);
  });

  it("drops malformed entries and clamps an out-of-range cursor", () => {
    const result = sanitize({
      entries: [entry(1), { number: 2 }, entry(3)],
      cursor: 9,
    });
    expect(result.entries.map((e) => e.id)).toEqual(["id-1", "id-3"]);
    expect(result.cursor).toBe(0);
  });

  it("truncates over-long persisted trails", () => {
    const entries = Array.from({ length: MAX_TRAIL_ENTRIES + 4 }, (_, i) => entry(i));
    const result = sanitize({ entries, cursor: 0 });
    expect(result.entries).toHaveLength(MAX_TRAIL_ENTRIES);
  });
});
