// #230 — a repoPath that cannot be locked AT ALL must FAIL the merge with a real reason,
// not be polled as if it were merely contended.
//
// Measured symptom this pins (from the ticket): seeding a workspace with a synthetic
// `repoPath` (`/repo-<uuid>`, as several existing merge tests do) made `acquireOnDiskRepoLock`
// poll forever — every test hung until vitest's 60s timeout, with zero diagnostic output.
// `tryAcquireRepoLock` returned the same bare `null` for "someone holds it" and "this path
// can never be locked", so the waiter could not tell the two apart.
//
// The two assertions here are what a caller depends on:
//  1. the rejection happens WITHOUT spending the wait budget (no polling), and
//  2. it carries a merge reason a human/monitor can act on (`repo_lock_unavailable`),
//     explicitly distinguished from contention.

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireOnDiskRepoLock, acquireRepoMergeLock, WorkspaceError, activeMerges } from "../services/workspace-internals.js";

describe("on-disk repo lock: UNAVAILABLE fails fast (#230)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    activeMerges.clear();
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("rejects immediately for a repoPath with no .git, without waiting out the bound", async () => {
    const missing = join(tmpdir(), `repo-lock-unavailable-${Date.now()}`);
    let sleeps = 0;
    const startedAt = Date.now();

    await expect(
      acquireOnDiskRepoLock(missing, "ws-1", {
        // A budget so large that any polling at all would hang the test.
        timeoutMs: 60 * 60 * 1000,
        sleep: async () => { sleeps++; },
      }),
    ).rejects.toThrow(/not lock contention/);

    expect(sleeps).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("surfaces the failure to the MERGE caller as a repo_lock_unavailable WorkspaceError", async () => {
    const missing = join(tmpdir(), `repo-lock-unavailable-merge-${Date.now()}`);
    let ranWork = false;

    const err = await acquireRepoMergeLock(missing, "ws-2", async () => {
      ranWork = true;
      return "merged";
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(ranWork).toBe(false);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect((err as WorkspaceError).data?.mergeReason).toBe("repo_lock_unavailable");
    expect((err as WorkspaceError).message).toMatch(/does not exist/);
    // The in-memory lock must not be left installed by a failed acquisition.
    expect(activeMerges.get(missing)).toBeUndefined();
  });

  it("still WAITS (does not fail fast) when the lock is merely contended", async () => {
    const repo = mkdtempSync(join(tmpdir(), "repo-lock-contended-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    dirs.push(repo);

    const held = await acquireOnDiskRepoLock(repo, "holder");
    try {
      let sleeps = 0;
      await expect(
        acquireOnDiskRepoLock(repo, "waiter", {
          timeoutMs: 40,
          pollMs: 10,
          sleep: async (ms) => { sleeps++; await new Promise((r) => setTimeout(r, ms)); },
        }),
      ).rejects.toThrow(/timed out/);
      // Contention is waited out (and reported as a timeout), never mislabelled unavailable.
      expect(sleeps).toBeGreaterThan(0);
    } finally {
      held.release();
    }
  });
});
