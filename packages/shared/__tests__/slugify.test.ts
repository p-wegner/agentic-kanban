/**
 * #565 — nine hand-rolled copies of one rule, with drift. These lock the base rule and the
 * two properties the copies disagreed on: the length cap must not leave a dangling "-", and
 * diacritics fold rather than becoming separators.
 */
import { describe, it, expect } from "vitest";
import { slugify } from "../src/lib/slugify.js";

describe("slugify (#565)", () => {
  it("lowercases and collapses non-alphanumeric runs to a single dash", () => {
    expect(slugify("Fix the  merge__gate (again)!")).toBe("fix-the-merge-gate-again");
  });

  it("trims leading and trailing separators", () => {
    expect(slugify("  --Hello--  ")).toBe("hello");
  });

  it("does not leave a dangling dash when the cap lands inside a separator run", () => {
    // The drifted copies sliced and returned; one of them could emit "abc-" as a filename
    // segment or a branch suffix.
    expect(slugify("abc def", { maxLength: 4 })).toBe("abc");
    expect(slugify("abcdefgh", { maxLength: 4 })).toBe("abcd");
  });

  it("folds diacritics instead of turning them into separators", () => {
    // Only the client's project-URL slugger did this; everywhere else "Übersicht" lost its
    // first letter to a dash.
    expect(slugify("Übersicht")).toBe("ubersicht");
    expect(slugify("Grüße, Åsa")).toBe("grusse-asa");
  });

  it("returns the fallback only when nothing usable survives", () => {
    expect(slugify("!!!", { fallback: "issue" })).toBe("issue");
    expect(slugify("", { fallback: "issue" })).toBe("issue");
    expect(slugify(null, { fallback: "issue" })).toBe("issue");
    expect(slugify("ok", { fallback: "issue" })).toBe("ok");
  });

  it("defaults to an empty string when the caller wants no fallback", () => {
    // A branch-name slug is appended to a prefix that is already unique, so "" is correct
    // there and a fabricated word would be worse.
    expect(slugify("###")).toBe("");
  });
});
