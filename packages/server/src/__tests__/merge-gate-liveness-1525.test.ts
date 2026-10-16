import { describe, expect, it, vi } from "vitest";
import type { Database } from "../db/index.js";
import { gateObsoleteReason, watchGateLiveness } from "../services/merge-gate-liveness.js";

const db = {} as Database;

describe("merge gate liveness (#1525)", () => {
  it("is obsolete once the workspace is merged or closed", async () => {
    for (const status of ["merged", "closed"]) {
      const r = await gateObsoleteReason({ workspaceId: "w", workingDir: null, startSha: "", database: db }, { readStatus: async () => status });
      expect(r).toContain(status);
    }
  });
  it("is obsolete when the branch head moved", async () => {
    const r = await gateObsoleteReason({ workspaceId: "w", workingDir: "/x", startSha: "aaaaaaaa11", database: db }, { readStatus: async () => "reviewing", readHead: async () => "bbbbbbbb22" });
    expect(r).toContain("moved");
  });
  it("stays live while open on the same head", async () => {
    const r = await gateObsoleteReason({ workspaceId: "w", workingDir: "/x", startSha: "aaa", database: db }, { readStatus: async () => "reviewing", readHead: async () => "aaa" });
    expect(r).toBeNull();
  });
  it("the watcher cancels the gate when the workspace closes, and never for a train", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => true);
    const stop = watchGateLiveness({ workspaceId: "w", workingDir: "/x", database: db }, { readStatus: async () => "closed", readHead: async () => "a", intervalMs: 10, cancel });
    await vi.advanceTimersByTimeAsync(50);
    expect(cancel).toHaveBeenCalledWith("w");
    stop();
    const trainCancel = vi.fn(() => true);
    watchGateLiveness({ workspaceId: "train:x", workingDir: "/x", database: db }, { readStatus: async () => "closed", intervalMs: 10, cancel: trainCancel });
    await vi.advanceTimersByTimeAsync(50);
    expect(trainCancel).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
