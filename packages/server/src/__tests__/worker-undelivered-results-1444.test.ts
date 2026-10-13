import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createUndeliveredStore } from "../worker/worker-undelivered-retry.js";
import { dropUndelivered, loadLost, loadUndelivered, upsertUndelivered, withUndeliveredLock } from "../worker/worker-undelivered.js";

const record = (sessionId: string, over: Record<string, unknown> = {}) => ({
  sessionId, branch: "b", baseBranch: "m", incomingRef: "refs/kanban/incoming/b", checkoutPath: "/c",
  cacheDir: "/k", projectId: "p", gitPort: 1, attempts: 1, lastError: "x", recordedAt: new Date().toISOString(), ...over,
});
const makeStore = (workRoot: string, error: string) =>
  createUndeliveredStore({
    workRoot, boardUrl: "u", retryDelaysMs: [], push: vi.fn().mockRejectedValue(new Error(error)),
    cleanup: async () => {}, safeSend: () => {}, wait: async () => {}, isGone: async () => false,
  });

describe("undelivered results #1444", () => {
  it("keeps headSha through the file and into the lost list", () => {
    const root = mkdtempSync(join(tmpdir(), "ak-undel-"));
    const sha = "a".repeat(40);
    upsertUndelivered(root, record("s1", { headSha: sha }));
    expect(loadUndelivered(root)[0].headSha).toBe(sha);
  });

  it("drop removes retained entries, and lost ones only with --lost", () => {
    const root = mkdtempSync(join(tmpdir(), "ak-undel-"));
    upsertUndelivered(root, record("s1"));
    upsertUndelivered(root, record("s2"));
    expect(dropUndelivered(root, ["s1", "nope"])).toEqual(["s1"]);
    expect(loadUndelivered(root).map((r) => r.sessionId)).toEqual(["s2"]);
  });

  it("holds the lock exclusively and releases it after an error", () => {
    const root = mkdtempSync(join(tmpdir(), "ak-undel-"));
    expect(() => withUndeliveredLock(root, () => { throw new Error("boom"); })).toThrow("boom");
    expect(withUndeliveredLock(root, () => 7)).toBe(7);
  });

  it("moves a retry that keeps failing on auth to lost, with the reason and sha", async () => {
    const root = mkdtempSync(join(tmpdir(), "ak-undel-"));
    const sha = "b".repeat(40);
    upsertUndelivered(root, record("s3", { attempts: 4, headSha: sha, lastError: "fatal: could not read Username for http://board:3002" }));
    const store = makeStore(root, "fatal: could not read Username for http://board:3002");
    await store.retryPending();
    expect(store.list()).toEqual([]);
    expect(loadUndelivered(root)).toEqual([]);
    const lost = loadLost(root);
    expect(lost).toHaveLength(1);
    expect(lost[0].headSha).toBe(sha);
    expect(lost[0].reason).toContain("credentials");
  });

  it("keeps retrying a non-auth failure at the same attempt count", async () => {
    const root = mkdtempSync(join(tmpdir(), "ak-undel-"));
    upsertUndelivered(root, record("s4", { attempts: 4 }));
    const store = makeStore(root, "connection refused");
    await store.retryPending();
    expect(store.list()).toHaveLength(1);
    expect(loadLost(root)).toEqual([]);
  });
});
