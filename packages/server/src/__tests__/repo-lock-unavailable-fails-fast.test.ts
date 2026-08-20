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

    // `sleeps === 0` is the real proof that the wait budget was not spent — it is exact and
    // load-independent. The wall-clock check is kept as a coarse backstop but widened well past
    // anything contention can produce (#680): at 5s it was a second load-dependent assertion
    // guarding a property the line above already establishes.
    expect(sleeps).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(60_000);
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
          // #680 — this was `timeoutMs: 40, pollMs: 10`, and it is one of the ten load-dependent
          // failures that made master red while passing in isolation (observed: failed in 192ms,
          // an assertion rather than a timeout). With a 40ms budget, a single scheduling hiccup
          // on a loaded box means the deadline passes before the FIRST poll is attempted, so
          // `sleeps` is 0 and the assertion below fails — reporting "contention is not waited
          // out" when the only thing measured was the scheduler.
          //
          // 2s with 10ms polls keeps the property (~200 polls available, so at least one is
          // certain) while still failing in about two seconds. The injected `sleep` really waits,
          // so this does not spin.
          timeoutMs: 2_000,
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
