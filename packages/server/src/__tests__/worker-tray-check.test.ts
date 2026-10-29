import { describe, expect, it } from "vitest";
import { checkTray, describeTray } from "../cli/commands/worker-tray-check.js";

describe("worker tray check (#1774)", () => {
  it("is Windows-only", () => {
    expect(describeTray("linux", false)).toBeNull();
    expect(checkTray("darwin", false)).toBeNull();
  });
  it("warns when the tray is not running, with a remedy", () => {
    const c = describeTray("win32", false)!;
    expect(c.status).toBe("warn");
    expect(c.remedy).toMatch(/tray-launch/);
  });
  it("passes when running and is unknown when the probe failed", () => {
    expect(describeTray("win32", true)!.status).toBe("pass");
    expect(describeTray("win32", null)!.status).toBe("unknown");
  });
});
