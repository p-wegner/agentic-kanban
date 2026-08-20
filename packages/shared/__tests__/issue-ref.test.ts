import { describe, expect, it } from "vitest";
import { isNumericIssueRef, parseIssueRef } from "../src/lib/issue-ref.js";

/**
 * The one number-or-id policy (#509), plus the `#N` spelling it now accepts (#701).
 *
 * Worth pinning because both directions are load-bearing: a ref read as a NUMBER is looked up
 * per-project (and is meaningless without one), while a ref read as an ID goes straight to a
 * globally unique lookup. Getting `#701` wrong sent the documented spelling down the id path,
 * where it can only ever be "not found".
 */
describe("parseIssueRef", () => {
  it("reads a bare number, a `#N` and a numeric-with-whitespace as the same number", () => {
    expect(parseIssueRef("701")).toEqual({ kind: "number", issueNumber: 701 });
    expect(parseIssueRef("#701")).toEqual({ kind: "number", issueNumber: 701 });
    expect(parseIssueRef("  #701 ")).toEqual({ kind: "number", issueNumber: 701 });
    expect(parseIssueRef(701)).toEqual({ kind: "number", issueNumber: 701 });
  });

  it("reads anything else as an id, untouched", () => {
    const uuid = "0df58ef3-c472-4e9b-a2aa-e955b9c60c48";
    expect(parseIssueRef(uuid)).toEqual({ kind: "id", issueId: uuid });
    // Not a number ref: `#` only counts in front, and a suffix is part of an id.
    expect(parseIssueRef("701a")).toEqual({ kind: "id", issueId: "701a" });
    expect(parseIssueRef("ak-701")).toEqual({ kind: "id", issueId: "ak-701" });
    expect(parseIssueRef("7#01")).toEqual({ kind: "id", issueId: "7#01" });
  });

  it("isNumericIssueRef agrees with parseIssueRef, including on `#N`", () => {
    expect(isNumericIssueRef("#701")).toBe(true);
    expect(isNumericIssueRef("701")).toBe(true);
    expect(isNumericIssueRef("ak-701")).toBe(false);
  });
});
