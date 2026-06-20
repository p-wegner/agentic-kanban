import { describe, expect, it } from "vitest";
import { isAutodriveStallWarning, parseCycleLine, type MonitorWarning } from "./monitor-popover.js";

describe("isAutodriveStallWarning", () => {
  it("narrows to the autodrive-stall variant by its `type` discriminant", () => {
    const stall = { type: "autodrive_stall", message: "stalled" } as unknown as MonitorWarning;
    const dirty = { message: "dirty", files: ["a.ts"] } as unknown as MonitorWarning; // no `type` field
    expect(isAutodriveStallWarning(stall)).toBe(true);
    expect(isAutodriveStallWarning(dirty)).toBe(false);
  });
});

describe("parseCycleLine", () => {
  it("splits a pipe-delimited line, keeping a valid ISO timestamp as age", () => {
    const r = parseCycleLine("2026-06-20T10:00:00Z | merge | issue 5");
    expect(r.age).toBe("2026-06-20T10:00:00Z");
    expect(r.text).toBe("merge · issue 5");
  });

  it("returns null age when the first field is not a date", () => {
    const r = parseCycleLine("notadate | merge");
    expect(r.age).toBeNull();
    expect(r.text).toBe("merge");
  });

  it("returns the raw line with null age when there is no pipe", () => {
    const r = parseCycleLine("plain cycle line");
    expect(r.age).toBeNull();
    expect(r.text).toBe("plain cycle line");
  });
});
