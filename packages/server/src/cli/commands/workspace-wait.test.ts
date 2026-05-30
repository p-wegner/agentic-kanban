import { describe, it, expect } from "vitest";
import { classifyStatus } from "./workspace-wait.js";

describe("classifyStatus", () => {
  it("returns 0 for success terminal states", () => {
    for (const status of ["idle", "ready_for_merge", "closed", "merged"]) {
      expect(classifyStatus(status)).toBe(0);
    }
  });

  it("returns 1 for error terminal states", () => {
    for (const status of ["error", "failed"]) {
      expect(classifyStatus(status)).toBe(1);
    }
  });

  it("returns null for in-flight (non-terminal) states", () => {
    for (const status of ["active", "reviewing", "merging", "setup"]) {
      expect(classifyStatus(status)).toBeNull();
    }
  });

  it("returns null for unknown statuses (keeps waiting rather than false-exiting)", () => {
    expect(classifyStatus("some_future_status")).toBeNull();
  });
});
