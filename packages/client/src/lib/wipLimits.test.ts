import { describe, it, expect } from "vitest";
import { wipLimitKey, getWipLimit, evaluateWipLimit } from "./wipLimits.js";

describe("wipLimitKey", () => {
  it("produces correct key", () => {
    expect(wipLimitKey("abc-123")).toBe("wip_limit_abc-123");
  });
});

describe("getWipLimit", () => {
  it("returns null when key absent", () => {
    expect(getWipLimit({}, "abc")).toBeNull();
  });

  it("parses valid limit", () => {
    expect(getWipLimit({ wip_limit_abc: "3" }, "abc")).toBe(3);
  });

  it("returns null for zero", () => {
    expect(getWipLimit({ wip_limit_abc: "0" }, "abc")).toBeNull();
  });

  it("returns null for non-numeric", () => {
    expect(getWipLimit({ wip_limit_abc: "foo" }, "abc")).toBeNull();
  });
});

describe("evaluateWipLimit", () => {
  it("returns under when count < limit", () => {
    expect(evaluateWipLimit(2, 5)).toBe("under");
  });

  it("returns at when count === limit", () => {
    expect(evaluateWipLimit(5, 5)).toBe("at");
  });

  it("returns over when count > limit", () => {
    expect(evaluateWipLimit(6, 5)).toBe("over");
  });

  it("returns under when no limit", () => {
    expect(evaluateWipLimit(10, null)).toBe("under");
  });
});
