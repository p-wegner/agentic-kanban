import { describe, it, expect } from "vitest";
import { arePropsEqualIgnoring } from "./propsEqualIgnoring";

const IGNORED = new Set<string>(["onClick", "quickUpdate"]);

describe("arePropsEqualIgnoring", () => {
  it("treats identical props as equal", () => {
    const props = { id: "a", count: 1, onClick: () => {} };
    expect(arePropsEqualIgnoring({ ...props }, { ...props }, IGNORED)).toBe(true);
  });

  it("ignores a changed handler prop — the whole point of the rule", () => {
    expect(
      arePropsEqualIgnoring(
        { id: "a", onClick: () => "old", quickUpdate: () => "old" },
        { id: "a", onClick: () => "new", quickUpdate: () => "new" },
        IGNORED,
      ),
    ).toBe(true);
  });

  it("reports a changed data prop even when the handlers are identical", () => {
    const onClick = () => {};
    expect(
      arePropsEqualIgnoring({ id: "a", onClick }, { id: "b", onClick }, IGNORED),
    ).toBe(false);
  });

  it("compares by identity, not by value — a new object with equal fields differs", () => {
    expect(
      arePropsEqualIgnoring({ tags: ["x"] }, { tags: ["x"] }, IGNORED),
    ).toBe(false);
  });

  it("takes the UNION of both key sets, so an added prop is a difference", () => {
    expect(
      arePropsEqualIgnoring(
        { id: "a" } as { id: string; extra?: number },
        { id: "a", extra: 1 },
        IGNORED,
      ),
    ).toBe(false);
  });

  it("takes the UNION of both key sets, so a removed prop is a difference", () => {
    expect(
      arePropsEqualIgnoring(
        { id: "a", extra: 1 } as { id: string; extra?: number },
        { id: "a" },
        IGNORED,
      ),
    ).toBe(false);
  });

  it("does not confuse an absent prop with an explicit undefined", () => {
    // `Object.is(undefined, undefined)` is true, so this pair IS equal — the union
    // rule only guarantees the key is visited, not that presence itself differs.
    expect(
      arePropsEqualIgnoring(
        { id: "a", extra: undefined } as { id: string; extra?: number },
        { id: "a" },
        IGNORED,
      ),
    ).toBe(true);
  });

  it("uses Object.is semantics: NaN equals NaN", () => {
    expect(arePropsEqualIgnoring({ n: NaN }, { n: NaN }, IGNORED)).toBe(true);
  });

  it("uses Object.is semantics: +0 and -0 differ", () => {
    expect(arePropsEqualIgnoring({ n: 0 }, { n: -0 }, IGNORED)).toBe(false);
  });

  it("an empty ignore set compares every prop", () => {
    const empty = new Set<string>();
    expect(
      arePropsEqualIgnoring({ onClick: () => "a" }, { onClick: () => "b" }, empty),
    ).toBe(false);
  });
});
