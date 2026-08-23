import { describe, it, expect } from "vitest";
import { arePropsEqualIgnoring } from "./propsEqualIgnoring";

/**
 * The ignored-key set, as a factory rather than one shared `Set<string>`.
 *
 * `arePropsEqualIgnoring` takes `ReadonlySet<keyof P>` on purpose — that is what makes a
 * typo in an ignored key name a compile error at the call sites in `IssueCard.tsx`. A
 * single `Set<string>` is therefore not assignable to it, and each test here uses a
 * different prop shape. So the set is built per call at that call's own `P`; the
 * contents are the same everywhere. The one assertion is on the literal array we just
 * wrote, not on anything the function under test produces.
 */
const ignored = <P extends object>(...keys: string[]): ReadonlySet<keyof P> =>
  new Set(keys as (keyof P)[]);

const IGNORED_KEYS = ["onClick", "quickUpdate"];

describe("arePropsEqualIgnoring", () => {
  it("treats identical props as equal", () => {
    const props = { id: "a", count: 1, onClick: () => {} };
    expect(arePropsEqualIgnoring({ ...props }, { ...props }, ignored(...IGNORED_KEYS))).toBe(true);
  });

  it("ignores a changed handler prop — the whole point of the rule", () => {
    expect(
      arePropsEqualIgnoring(
        { id: "a", onClick: () => "old", quickUpdate: () => "old" },
        { id: "a", onClick: () => "new", quickUpdate: () => "new" },
        ignored(...IGNORED_KEYS),
      ),
    ).toBe(true);
  });

  it("reports a changed data prop even when the handlers are identical", () => {
    const onClick = () => {};
    expect(
      arePropsEqualIgnoring({ id: "a", onClick }, { id: "b", onClick }, ignored(...IGNORED_KEYS)),
    ).toBe(false);
  });

  it("compares by identity, not by value — a new object with equal fields differs", () => {
    expect(
      arePropsEqualIgnoring({ tags: ["x"] }, { tags: ["x"] }, ignored(...IGNORED_KEYS)),
    ).toBe(false);
  });

  it("takes the UNION of both key sets, so an added prop is a difference", () => {
    expect(
      arePropsEqualIgnoring(
        { id: "a" } as { id: string; extra?: number },
        { id: "a", extra: 1 },
        ignored(...IGNORED_KEYS),
      ),
    ).toBe(false);
  });

  it("takes the UNION of both key sets, so a removed prop is a difference", () => {
    expect(
      arePropsEqualIgnoring(
        { id: "a", extra: 1 } as { id: string; extra?: number },
        { id: "a" },
        ignored(...IGNORED_KEYS),
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
        ignored(...IGNORED_KEYS),
      ),
    ).toBe(true);
  });

  it("uses Object.is semantics: NaN equals NaN", () => {
    expect(arePropsEqualIgnoring({ n: NaN }, { n: NaN }, ignored(...IGNORED_KEYS))).toBe(true);
  });

  it("uses Object.is semantics: +0 and -0 differ", () => {
    expect(arePropsEqualIgnoring({ n: 0 }, { n: -0 }, ignored(...IGNORED_KEYS))).toBe(false);
  });

  it("an empty ignore set compares every prop", () => {
    const empty = ignored();
    expect(
      arePropsEqualIgnoring({ onClick: () => "a" }, { onClick: () => "b" }, empty),
    ).toBe(false);
  });
});
