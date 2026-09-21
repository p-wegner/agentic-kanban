import { describe, it, expect } from "vitest";
import { isResolveConflictsNoop } from "../services/resolve-conflicts-noop.js";

describe("isResolveConflictsNoop (#1209)", () => {
  it("is a no-op when the tip is unchanged AND still conflicting", () => {
    expect(isResolveConflictsNoop({
      headShaBeforeSession: "abc",
      headShaAfterSession: "abc",
      stillConflicting: true,
    })).toBe(true);
  });

  it("is NOT a no-op when the tip moved, even if still conflicting (a later conflict is real progress)", () => {
    expect(isResolveConflictsNoop({
      headShaBeforeSession: "abc",
      headShaAfterSession: "def",
      stillConflicting: true,
    })).toBe(false);
  });

  it("is NOT a no-op when the conflict is resolved, even if the tip is unchanged", () => {
    expect(isResolveConflictsNoop({
      headShaBeforeSession: "abc",
      headShaAfterSession: "abc",
      stillConflicting: false,
    })).toBe(false);
  });

  it("fails open (not a no-op) when either sha could not be determined", () => {
    expect(isResolveConflictsNoop({
      headShaBeforeSession: null,
      headShaAfterSession: "abc",
      stillConflicting: true,
    })).toBe(false);
    expect(isResolveConflictsNoop({
      headShaBeforeSession: "abc",
      headShaAfterSession: null,
      stillConflicting: true,
    })).toBe(false);
  });
});
