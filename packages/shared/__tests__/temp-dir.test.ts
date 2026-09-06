import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  createManagedTempDir,
  sweepStaleTempDirs,
  sweepStaleTempDirsAsync,
  TEMP_DIR_OWNER_FILE,
  TEMP_DIR_NAMESPACE,
  withTempDir,
} from "../src/lib/temp-dir.js";

/**
 * The helper #362/#364 introduce so that creating a throwaway directory and removing it are
 * written in the same place. These tests are the regression bar for the two properties that
 * actually failed on the machine: a disposer that runs on EVERY exit path, and a sweep that
 * recovers a run that was killed before any teardown could run.
 */

const roots: string[] = [];
function sweepRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kanban-temp-dir-spec-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
});

describe("createManagedTempDir", () => {
  it("creates a directory and removes it on dispose, idempotently", () => {
    const dir = createManagedTempDir("kanban-managed-spec-");
    expect(existsSync(dir.path)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir.path, TEMP_DIR_OWNER_FILE), "utf8"))).toEqual({ pid: process.pid });
    writeFileSync(join(dir.path, "payload.txt"), "x", "utf8");

    expect(dir.dispose()).toBe(true);
    expect(existsSync(dir.path)).toBe(false);
    // Second call must not throw and must still report success.
    expect(dir.dispose()).toBe(true);
  });

  it("refuses a prefix outside the kanban- namespace", () => {
    // A directory a sweep cannot recognise is one that leaks forever the moment its disposer
    // is missed — which is exactly how 8,448 of them accumulated.
    // The prefix here is REFUSED, so it names a directory that is never created; namespacing
    // it would delete the assertion.
    // TEMP-PREFIX OK: negative test — this prefix must stay outside the namespace (#839).
    expect(() => createManagedTempDir("some-other-tool-")).toThrow(/must start with "kanban-"/);
    expect(TEMP_DIR_NAMESPACE).toBe("kanban-");
  });
});

describe("withTempDir", () => {
  it("disposes when the body returns", async () => {
    let seen = "";
    const value = await withTempDir("kanban-with-spec-", (dir) => {
      seen = dir;
      return 42;
    });
    expect(value).toBe(42);
    expect(existsSync(seen)).toBe(false);
  });

  it("disposes when the body THROWS — the path every early return used to miss", async () => {
    let seen = "";
    await expect(withTempDir("kanban-with-throw-spec-", (dir) => {
      seen = dir;
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(seen).not.toBe("");
    expect(existsSync(seen)).toBe(false);
  });
});

describe("sweepStaleTempDirs", () => {
  function agedDir(root: string, name: string, ageMs: number): string {
    const full = join(root, name);
    mkdirSync(full, { recursive: true });
    const when = new Date(Date.now() - ageMs);
    utimesSync(full, when, when);
    return full;
  }

  it.each([sweepStaleTempDirs, sweepStaleTempDirsAsync])("preserves old live owners and reclaims dead ones (%#)", async (sweep) => {
    const root = sweepRoot();
    const live = agedDir(root, "kanban-owner-live", 0);
    const dead = agedDir(root, "kanban-owner-dead", 0);
    const child = spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
    expect(child.status).toBe(0);
    writeFileSync(join(live, TEMP_DIR_OWNER_FILE), JSON.stringify({ pid: process.pid }));
    writeFileSync(join(dead, TEMP_DIR_OWNER_FILE), JSON.stringify({ pid: child.pid }));
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    for (const dir of [live, dead]) utimesSync(dir, old, old);
    const result = await sweep("kanban-owner-", { root });
    expect(result.removed).toBe(1);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(dead)).toBe(false);
  });

  it("production cleanup retains unowned legacy roots and malformed ownership", async () => {
    const root = sweepRoot();
    const legacy = agedDir(root, "kanban-legacy-old", 3 * 60 * 60_000);
    const invalid = agedDir(root, "kanban-invalid-old", 0);
    writeFileSync(join(invalid, TEMP_DIR_OWNER_FILE), "partial-write");
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    utimesSync(invalid, old, old);
    expect((await sweepStaleTempDirsAsync("kanban-", { root, retainUnowned: true })).removed).toBe(0);
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(invalid)).toBe(true);
  });

  it("async disposal yields to the event loop before completing", async () => {
    const dir = createManagedTempDir("kanban-async-spec-");
    roots.push(dir.path);
    let heartbeat = false;
    const tick = new Promise<void>((resolve) => setImmediate(() => { heartbeat = true; resolve(); }));
    const removed = await dir.disposeAsync();
    expect(removed).toBe(true);
    expect(heartbeat).toBe(true);
    await tick;
    expect(await dir.disposeAsync()).toBe(true);
  });

  it("reaps matching dirs older than the cutoff and leaves fresh ones alone", () => {
    const root = sweepRoot();
    const old = agedDir(root, "kanban-sweep-me-aaa", 3 * 60 * 60_000);
    const fresh = agedDir(root, "kanban-sweep-me-bbb", 1_000);

    const result = sweepStaleTempDirs("kanban-sweep-me-", { root, olderThanMs: 60 * 60_000 });

    expect(result.removed).toBe(1);
    expect(result.failed).toBe(0);
    expect(existsSync(old)).toBe(false);
    // The age gate is what makes this safe to run while a SIBLING checkout's suite is live.
    expect(existsSync(fresh)).toBe(true);
  });

  it("never touches a dir outside the requested prefix", () => {
    const root = sweepRoot();
    const other = agedDir(root, "kanban-other-family-aaa", 3 * 60 * 60_000);

    const result = sweepStaleTempDirs("kanban-sweep-me-", { root, olderThanMs: 60 * 60_000 });

    expect(result.matched).toBe(0);
    expect(existsSync(other)).toBe(true);
  });

  it("stops at maxRemovals and reports the truncation rather than hanging a run", () => {
    const root = sweepRoot();
    for (let i = 0; i < 5; i++) agedDir(root, `kanban-sweep-many-${i}`, 3 * 60 * 60_000);

    const result = sweepStaleTempDirs("kanban-sweep-many-", { root, olderThanMs: 60 * 60_000, maxRemovals: 2 });

    expect(result.removed).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("returns an empty result for an unreadable root instead of throwing", () => {
    const result = sweepStaleTempDirs("kanban-nope-", { root: join(tmpdir(), "kanban-does-not-exist-zzz") });
    expect(result).toEqual({ matched: 0, removed: 0, failed: 0, truncated: false });
  });
});
