import { describe, it, expect } from "vitest";
import { diffRangeArgs } from "../src/lib/git-service/diff.js";

describe("diffRangeArgs (#530)", () => {
  it("uses three-dot for a branch workspace", () => {
    expect(diffRangeArgs("master")).toEqual(["master...HEAD"]);
  });

  it("uses a bare HEAD for the direct-workspace sentinel", () => {
    // `getDiff` used to build "HEAD...HEAD" here, which git evaluates as EMPTY — so a
    // direct workspace's diff silently showed untracked files only, hiding every
    // modified tracked file. The whole point of the sentinel is to avoid a range.
    expect(diffRangeArgs("HEAD")).toEqual(["HEAD"]);
    expect(diffRangeArgs("HEAD")).not.toContain("HEAD...HEAD");
  });

  it("does not treat a branch merely CONTAINING 'HEAD' as the sentinel", () => {
    expect(diffRangeArgs("feature/HEADer")).toEqual(["feature/HEADer...HEAD"]);
  });
});
