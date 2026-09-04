/**
 * The narrowing rule as the roster EDITOR applies it (#1028), plus the labels that carry the
 * `unknown` distinction into the table.
 *
 * The widening cases are the point: a project roster that could raise a profile's role would
 * make a global `forbidden` liftable, which is the one property #1025 built structurally
 * rather than by convention.
 */
import { describe, expect, it } from "vitest";
import {
  allowedRolesFor,
  applyRoleChange,
  cooldownLabel,
  headroomLabel,
  isRoleWidening,
  measurementAgeLabel,
  removeFromRoster,
  resetLabel,
  type RosterDraftEntry,
} from "./rosterEditor.js";

const anth = { id: "claude:anth", provider: "claude" as const, name: "anth" };

describe("the narrowing rule", () => {
  it("calls a role above the account's own declaration a widening", () => {
    expect(isRoleWidening("pool", "forbidden")).toBe(true);
    expect(isRoleWidening("reserve", "forbidden")).toBe(true);
    expect(isRoleWidening("pool", "reserve")).toBe(true);
  });

  it("allows narrowing and an unchanged role", () => {
    expect(isRoleWidening("forbidden", "pool")).toBe(false);
    expect(isRoleWidening("reserve", "pool")).toBe(false);
    expect(isRoleWidening("pool", "pool")).toBe(false);
    expect(isRoleWidening("forbidden", "forbidden")).toBe(false);
  });

  it("offers only the roles a project may actually set", () => {
    expect(allowedRolesFor("pool")).toEqual(["pool", "reserve", "forbidden"]);
    expect(allowedRolesFor("reserve")).toEqual(["reserve", "forbidden"]);
    // A globally forbidden account can be nothing else — the dropdown has one option, and
    // that is the UI half of "unliftable by construction".
    expect(allowedRolesFor("forbidden")).toEqual(["forbidden"]);
  });
});

describe("applyRoleChange", () => {
  it("REJECTS a widening and leaves the roster untouched", () => {
    const entries: RosterDraftEntry[] = [{ provider: "claude", name: "anth", role: "forbidden" }];
    const result = applyRoleChange(entries, anth, "pool", "forbidden");

    expect(result.rejected).toContain("claude:anth");
    expect(result.rejected).toContain("narrow");
    expect(result.entries).toEqual(entries);
  });

  it("applies a narrowing, and adds a profile the roster did not list", () => {
    const narrowed = applyRoleChange(
      [{ provider: "claude", name: "anth", role: "pool" }],
      anth,
      "reserve",
      "pool",
    );
    expect(narrowed.rejected).toBeNull();
    expect(narrowed.entries).toEqual([{ provider: "claude", name: "anth", role: "reserve" }]);

    // `pool` on an unlisted profile ADDS it: the project roster is closed, so listing a
    // profile as pool is the only way to say "this project may use this account".
    const added = applyRoleChange([], anth, "pool", "pool");
    expect(added.entries).toEqual([{ provider: "claude", name: "anth", role: "pool" }]);
  });

  it("removes a profile from the roster entirely", () => {
    const entries: RosterDraftEntry[] = [
      { provider: "claude", name: "anth", role: "pool" },
      { provider: "codex", name: "work", role: "reserve" },
    ];
    expect(removeFromRoster(entries, "claude:anth")).toEqual([{ provider: "codex", name: "work", role: "reserve" }]);
  });
});

describe("the labels that carry the unknown distinction", () => {
  it("says the word `unknown` rather than a dash or a zero", () => {
    // The #1023 rule: a measurement older than one reset window is neither exhausted nor
    // empty. A dash a reader takes for "nothing used" is exactly the confusion to avoid.
    expect(headroomLabel(42, true)).toBe("unknown");
    expect(headroomLabel(null, true)).toBe("unknown");
    expect(headroomLabel(null, false)).toBe("—");
    expect(headroomLabel(42.4, false)).toBe("42%");
  });

  it("says `never` when nothing has been measured", () => {
    expect(measurementAgeLabel(null)).toBe("never");
    expect(measurementAgeLabel(30)).toBe("30s ago");
    expect(measurementAgeLabel(120)).toBe("2m ago");
    expect(measurementAgeLabel(7200)).toBe("2h ago");
  });

  it("shows no reset and no cooldown as an em dash, including for an elapsed stamp", () => {
    const nowMs = Date.parse("2026-09-04T12:00:00.000Z");
    expect(resetLabel(null)).toBe("—");
    expect(resetLabel("not-a-date")).toBe("—");
    expect(cooldownLabel(null, nowMs)).toBe("—");
    expect(cooldownLabel("2026-09-04T11:00:00.000Z", nowMs)).toBe("—");
    expect(cooldownLabel("2026-09-04T12:30:00.000Z", nowMs)).toBe("30m");
    expect(cooldownLabel("2026-09-04T15:00:00.000Z", nowMs)).toBe("3h");
  });
});
