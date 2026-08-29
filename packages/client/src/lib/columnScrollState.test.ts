import { describe, it, expect } from "vitest";
import { computeColumnScrollState, showsBottomFade, showsTopFade } from "./columnScrollState.js";

describe("computeColumnScrollState", () => {
  it("returns 'none' when content fits (no overflow)", () => {
    expect(computeColumnScrollState({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 })).toBe("none");
  });

  it("returns 'none' when overflow is within the 4px slack", () => {
    expect(computeColumnScrollState({ scrollTop: 0, scrollHeight: 103, clientHeight: 100 })).toBe("none");
  });

  it("returns 'top' when scrolled to the very top of a tall column", () => {
    expect(computeColumnScrollState({ scrollTop: 0, scrollHeight: 500, clientHeight: 200 })).toBe("top");
  });

  it("treats a sub-pixel scrollTop (<=2) as still at top", () => {
    expect(computeColumnScrollState({ scrollTop: 2, scrollHeight: 500, clientHeight: 200 })).toBe("top");
  });

  it("returns 'middle' when scrolled away from both ends", () => {
    expect(computeColumnScrollState({ scrollTop: 100, scrollHeight: 500, clientHeight: 200 })).toBe("middle");
  });

  it("returns 'bottom' when scrolled to the very bottom", () => {
    expect(computeColumnScrollState({ scrollTop: 300, scrollHeight: 500, clientHeight: 200 })).toBe("bottom");
  });

  it("treats a 2px gap at the bottom as still at bottom", () => {
    expect(computeColumnScrollState({ scrollTop: 298, scrollHeight: 500, clientHeight: 200 })).toBe("bottom");
  });
});

describe("fade visibility (#940)", () => {
  it("hides the top fade at rest, so nothing covers the first card", () => {
    // The regression: the top fade used to be tied to "top" — every column's resting
    // state — laying a 24px gradient over the upper part of the topmost ticket.
    expect(showsTopFade("top")).toBe(false);
  });

  it("shows the top fade only once content is scrolled off above", () => {
    expect(showsTopFade("middle")).toBe(true);
    expect(showsTopFade("bottom")).toBe(true);
  });

  it("hides the bottom fade at the end, so nothing covers the last card", () => {
    expect(showsBottomFade("bottom")).toBe(false);
  });

  it("shows the bottom fade only while content remains below", () => {
    expect(showsBottomFade("top")).toBe(true);
    expect(showsBottomFade("middle")).toBe(true);
  });

  it("shows no fade at all when the column does not scroll", () => {
    expect(showsTopFade("none")).toBe(false);
    expect(showsBottomFade("none")).toBe(false);
  });
});
