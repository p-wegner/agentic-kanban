// #1500 — a refused-as-no-longer-current push is recognised so the worker stops retrying and reports it.
import { describe, it, expect } from "vitest";
import { isAssignmentRefusal } from "../worker/worker-undelivered-retry.js";

describe("isAssignmentRefusal (#1500)", () => {
  it("matches the board's 403 refusal", () => {
    expect(isAssignmentRefusal("result push failed: HTTP 403 assignment is no longer current")).toBe(true);
    expect(isAssignmentRefusal("The requested URL returned error: 403")).toBe(true);
  });

  it("does not match transient or credential failures", () => {
    expect(isAssignmentRefusal("The requested URL returned error: 401")).toBe(false);
    expect(isAssignmentRefusal("connect ECONNREFUSED 127.0.0.1:3002")).toBe(false);
  });
});
