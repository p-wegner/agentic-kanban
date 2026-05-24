import { describe, expect, it } from "vitest";
import { classifyProcessExit } from "../../../../scripts/dev-supervisor.mjs";

describe("dev launcher exit classification", () => {
  it("treats intentional exits and termination signals as clean", () => {
    expect(classifyProcessExit(0, null)).toBe("clean");
    expect(classifyProcessExit(null, "SIGINT")).toBe("clean");
    expect(classifyProcessExit(null, "SIGTERM")).toBe("clean");
  });

  it("keeps code 1 fatal because tsx watch handles hot reload internally", () => {
    expect(classifyProcessExit(1, null)).toBe("fatal");
  });

  it("retries unexpected nonfatal exit codes", () => {
    expect(classifyProcessExit(143, null)).toBe("retry");
    expect(classifyProcessExit(2, null)).toBe("retry");
  });
});
