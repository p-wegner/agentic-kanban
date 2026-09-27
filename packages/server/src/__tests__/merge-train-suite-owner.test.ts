// A red train whose named suites all belong to one member rejects that member and re-gates the
// rest once, instead of control arm + halving (observed: train/2026-09-27-10, #1261's own suite).
import { describe, it, expect } from "vitest";
import { decideSuiteOwnerShortcut } from "../services/merge-train-suite-owner.js";

const m = (workspaceId: string, changedFiles?: string[] | null) => ({ workspaceId, branch: `f-${workspaceId}`, changedFiles });
const LOCKSTEP = "packages/server/src/__tests__/test-impact-budget-cap-lockstep.test.mjs";
const BACKSLASH = String.fromCharCode(92);
const WINDOWS_LOCKSTEP = "." + BACKSLASH + LOCKSTEP.split("/").join(BACKSLASH);

describe("decideSuiteOwnerShortcut", () => {
  const a = m("a", ["packages/server/src/x.ts", LOCKSTEP]);
  const b = m("b", ["packages/server/src/y.ts", "packages/server/src/__tests__/y.test.ts"]);

  it.each([
    ["one suite, one owner", [LOCKSTEP], [a, b], "a"],
    ["backslash and ./ spellings", [WINDOWS_LOCKSTEP], [a, b], "a"],
    ["two suites, same owner", [LOCKSTEP, "packages/server/src/x.ts"], [a, b], "a"],
    ["no suites named", [], [a, b], null],
    ["suites absent", undefined, [a, b], null],
    ["a suite nobody touched", ["packages/server/src/__tests__/other.test.ts"], [a, b], null],
    ["suites split across owners", [LOCKSTEP, "packages/server/src/__tests__/y.test.ts"], [a, b], null],
    ["one owned, one untouched", [LOCKSTEP, "packages/server/src/__tests__/other.test.ts"], [a, b], null],
    ["a single member (bisect's own singleton rule applies)", [LOCKSTEP], [a], null],
  ] as const)("%s", (_name, suites, members, expected) => {
    const got = decideSuiteOwnerShortcut(suites as readonly string[] | undefined, members);
    expect(got?.owner.workspaceId ?? null).toBe(expected);
  });

  it("refuses when two members both changed the failing suite", () => {
    const both = m("c", [LOCKSTEP]);
    expect(decideSuiteOwnerShortcut([LOCKSTEP], [a, both])).toBeNull();
  });

  it("treats a member with no changedFiles as owning nothing", () => {
    expect(decideSuiteOwnerShortcut([LOCKSTEP], [a, m("d", null), m("e")])?.owner.workspaceId).toBe("a");
  });
});
