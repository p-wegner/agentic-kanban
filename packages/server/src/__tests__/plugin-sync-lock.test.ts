import { describe, expect, it } from "vitest";
import { isSyncLocked, withSyncLock } from "../services/plugin-sync.service.js";

/** #1734: one lock per (plugin, project) over trigger, scheduler, resolve and test-connection. */
describe("withSyncLock", () => {
  it("refuses a second caller while a run is in flight, with a 409-coded message", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = withSyncLock("p1", "proj1", "pull", () => gate);
    expect(isSyncLocked("p1", "proj1")).toBe(true);
    await expect(withSyncLock("p1", "proj1", "push", async () => "x")).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/^sync already running \(pull, started \d{4}-/),
    });
    release();
    await first;
    expect(isSyncLocked("p1", "proj1")).toBe(false);
  });

  it("is per (plugin, project) and releases when the run throws", async () => {
    await expect(withSyncLock("p2", "proj1", "pull", async () => { throw new Error("timeout"); })).rejects.toThrow("timeout");
    expect(isSyncLocked("p2", "proj1")).toBe(false);
    let release!: () => void;
    const held = withSyncLock("p3", "projA", "pull", () => new Promise<void>((r) => { release = r; }));
    await expect(withSyncLock("p3", "projB", "pull", async () => "ok")).resolves.toBe("ok");
    release();
    await held;
  });
});
