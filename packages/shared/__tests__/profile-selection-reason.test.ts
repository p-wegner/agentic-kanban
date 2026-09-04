/**
 * The selection record itself (#1026) — the pure half, where the wording and the
 * `decidedBy` classification live.
 *
 * The classification is the part worth pinning: "headroom decided" and "there was only
 * ever one candidate" produce the same winner, and a record that called both `headroom`
 * would make the whole column untrustworthy for exactly the question it exists to answer.
 */
import { describe, expect, it } from "vitest";
import {
  buildProfileSelectionReason,
  parseProfileSelectionReason,
  serializeProfileSelectionReason,
} from "../src/lib/profile-selection-reason.js";

describe("buildProfileSelectionReason", () => {
  it("records nothing when nothing was selected", () => {
    expect(buildProfileSelectionReason({ selected: null, source: "strategy", candidates: [] })).toBeNull();
    expect(buildProfileSelectionReason({ selected: "  ", source: "strategy", candidates: [] })).toBeNull();
  });

  it("credits headroom only when a measurement existed to decide with", () => {
    const measured = buildProfileSelectionReason({
      selected: "claude:b",
      source: "strategy",
      candidates: [
        { id: "claude:a", usedPct: 95, exhausted: true },
        { id: "claude:b", usedPct: 20 },
      ],
    });
    expect(measured?.decidedBy).toBe("headroom");

    const unmeasured = buildProfileSelectionReason({
      selected: "claude:a",
      source: "strategy",
      candidates: [{ id: "claude:a", usedPct: null }, { id: "claude:b", usedPct: null }],
    });
    expect(unmeasured?.decidedBy).toBe("list-order");

    const alone = buildProfileSelectionReason({
      selected: "claude:a",
      source: "strategy",
      candidates: [{ id: "claude:a", usedPct: 12 }],
    });
    expect(alone?.decidedBy).toBe("explicit");
  });

  it("a clamp and a reserve start outrank the reading in what gets reported", () => {
    const base = {
      selected: "claude:b",
      source: "explicit-profile",
      candidates: [{ id: "claude:a", usedPct: 99, exhausted: true }, { id: "claude:b", usedPct: 3 }],
    };
    expect(buildProfileSelectionReason({ ...base, clamped: true })?.decidedBy).toBe("clamped");
    expect(buildProfileSelectionReason({ ...base, clamped: true, reserveUsed: true })?.decidedBy).toBe("reserve");
  });

  it("keeps a winner the candidate list never mentioned, rather than dropping it", () => {
    // An explicit profile an OPEN roster never listed still has to appear as the winner —
    // a record that omits the profile the session actually ran on is worse than none.
    const reason = buildProfileSelectionReason({
      selected: "claude:unlisted",
      source: "settings",
      candidates: [{ id: "claude:a", usedPct: 10 }],
    });
    expect(reason?.profile).toBe("claude:unlisted");
    expect(reason?.candidates[0]).toEqual({ id: "claude:unlisted", usedPct: null, outcome: "selected" });
  });

  it("names every loser and its reading in one readable line", () => {
    const reason = buildProfileSelectionReason({
      selected: "claude:b",
      source: "strategy",
      candidates: [
        { id: "claude:a", usedPct: 95, exhausted: true },
        { id: "claude:b", usedPct: 20 },
        { id: "claude:c", usedPct: null, cooling: true },
      ],
    });
    expect(reason?.summary).toContain("claude:a exhausted, 95% used");
    expect(reason?.summary).toContain("claude:c cooling, unmeasured");
    expect(reason?.candidates.map((c) => c.outcome)).toEqual(["exhausted", "selected", "cooling"]);
  });

  it("round-trips through the column, and reads an unusable value as 'not recorded'", () => {
    const reason = buildProfileSelectionReason({
      selected: "claude:b",
      source: "strategy",
      candidates: [{ id: "claude:b", usedPct: 20 }],
    });
    expect(parseProfileSelectionReason(serializeProfileSelectionReason(reason))).toEqual(reason);
    expect(parseProfileSelectionReason(null)).toBeNull();
    expect(parseProfileSelectionReason("not json")).toBeNull();
    expect(parseProfileSelectionReason("{}")).toBeNull();
  });
});
