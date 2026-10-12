import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUndeliveredStore } from "../worker/worker-undelivered-retry.js";
import { loadUndelivered, upsertUndelivered } from "../worker/worker-undelivered.js";

function setup(isGone: boolean) {
  const workRoot = mkdtempSync(join(tmpdir(), "kanban-undelivered-lost-"));
  upsertUndelivered(workRoot, {
    sessionId: "s1", branch: "feature/x", baseBranch: "master", incomingRef: "refs/kanban/incoming/feature/x",
    checkoutPath: join(workRoot, "gone"), cacheDir: join(workRoot, "cache"), projectId: "p", gitPort: 1,
    attempts: 1, lastError: "", recordedAt: "",
  });
  let pushes = 0;
  const store = createUndeliveredStore({
    workRoot, boardUrl: "http://b", retryDelaysMs: [],
    push: async () => { pushes += 1; throw new Error("working directory does not exist"); },
    cleanup: async () => {}, safeSend: () => {}, wait: async () => {},
    isGone: async () => isGone,
  });
  return { workRoot, store, pushes: () => pushes };
}

describe("undelivered result whose checkout and branch are gone (#1406)", () => {
  it("moves it to the lost list and stops retrying", async () => {
    const { workRoot, store, pushes } = setup(true);
    try {
      await store.retryPending();
      expect(store.list()).toEqual([]);
      expect(loadUndelivered(workRoot)).toEqual([]);
      expect(store.listLost().map((r) => r.sessionId)).toEqual(["s1"]);
      expect(store.listLost()[0].reason).toContain("no longer exist");
      await store.retryPending();
      expect(pushes()).toBe(1);
    } finally { rmSync(workRoot, { recursive: true, force: true }); }
  });

  it("keeps retrying while the work is still reachable", async () => {
    const { workRoot, store } = setup(false);
    try {
      await store.retryPending();
      expect(store.list().map((r) => r.sessionId)).toEqual(["s1"]);
      expect(store.listLost()).toEqual([]);
    } finally { rmSync(workRoot, { recursive: true, force: true }); }
  });
});
