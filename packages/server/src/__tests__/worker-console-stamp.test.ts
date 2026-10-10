import { afterEach, describe, expect, it, vi } from "vitest";
import { stampConsoleWithTimestamps } from "../worker/worker-updater.js";

describe("stampConsoleWithTimestamps (#1334)", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it("prefixes console.log with an ISO timestamp and restores cleanly", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    restore = stampConsoleWithTimestamps(Date.UTC(2026, 9, 10, 12, 0, 0));
    console.log("[worker] hello");
    expect(spy).toHaveBeenCalledWith("2026-10-10T12:00:00.000Z", "[worker] hello");
    restore();
    restore = undefined;
    spy.mockRestore();
  });
});
