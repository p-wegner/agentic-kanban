import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createUndeliveredStore } from "../worker/worker-undelivered-retry.js";
import { loadUndelivered, undeliveredStateFile, upsertUndelivered } from "../worker/worker-undelivered.js";
import { checkUndeliveredResults } from "../cli/commands/worker-doctor-undelivered.js";

const record = (sessionId: string, over: Record<string, unknown> = {}) => ({
  sessionId, branch: "b", baseBranch: "m", incomingRef: "refs/kanban/incoming/b", checkoutPath: "/c",
  cacheDir: "/k", projectId: "p", gitPort: 1, attempts: 1, lastError: "x", recordedAt: new Date().toISOString(), ...over,
});
const makeStore = (workRoot: string, push = vi.fn().mockRejectedValue(new Error("nope"))) =>
  ({ push, store: createUndeliveredStore({ workRoot, boardUrl: "u", retryDelaysMs: [], push, cleanup: async () => {}, safeSend: () => {}, wait: async () => {} }) });

describe("undelivered results give-up (#1416)", () => {
  it("does not write back an entry the operator deleted", async () => {
    const root = mkdtempSync(join(tmpdir(), "undel-"));
    upsertUndelivered(root, record("s1"));
    const { store, push } = makeStore(root);
    writeFileSync(undeliveredStateFile(root), JSON.stringify({ results: [] }));
    await store.retryPending();
    expect(push).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
    expect(loadUndelivered(root)).toEqual([]);
  });

  it("drops an entry past the attempt limit and logs it off the file", async () => {
    const root = mkdtempSync(join(tmpdir(), "undel-"));
    upsertUndelivered(root, record("s2", { attempts: 99 }));
    const { store, push } = makeStore(root);
    await store.retryPending();
    expect(push).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
    expect(readFileSync(undeliveredStateFile(root), "utf8")).not.toContain("s2");
  });

  it("drops an entry past the age limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "undel-"));
    upsertUndelivered(root, record("s3", { recordedAt: new Date(Date.now() - 8 * 86_400_000).toISOString() }));
    const { store } = makeStore(root);
    await store.retryPending();
    expect(store.list()).toEqual([]);
  });

  it("keeps and retries a fresh entry, and doctor lists it", async () => {
    const root = mkdtempSync(join(tmpdir(), "undel-"));
    upsertUndelivered(root, record("s4"));
    const { store, push } = makeStore(root);
    await store.retryPending();
    expect(push).toHaveBeenCalledTimes(1);
    expect(loadUndelivered(root)[0]?.attempts).toBe(2);
    const check = checkUndeliveredResults(root);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("s4");
    expect(check.detail).toContain("2 attempt");
  });
});
