import { defineConfig } from "vitest/config";
import path from "node:path";
import os from "node:os";

// Mirrors packages/server + packages/mcp-server — this was the last package still on the bare
// defaults, and it suffered the same "load flakes" (#46).
//
// The cost here has a different source from the sibling packages (no DB, no spawned server) but
// the same shape: the architecture gates SCAN THE WHOLE SOURCE TREE. check-god-modules-script
// shells out to the real gate script over ~1000 files (~9s observed), and max-file-size /
// git-exec-single-spawn / barrel-client-safety each walk every package's src/. That is
// legitimate work, so the default 5s budget measures machine load rather than correctness.
//
// Observed: `pnpm test:mine` reported check-god-modules-script, max-file-size and
// git-exec-single-spawn as FAILING while all three passed 10/10 in isolation and the gate
// script itself exited 0. These are the merge-blocking gates — false red on exactly the checks
// that exist to be trusted is the worst possible place for it.
//
// This is NOT papering over a hang: a genuine hang never completes, so it still trips the
// (raised) budget. Both knobs are env-overridable so a dedicated CI runner can opt back into
// full parallelism / tighter timeouts without touching this file.
//
// #206: 20s was still not enough headroom. This machine runs several agent sessions at once, so
// `pnpm test:mine` — which is ALSO the merge verify_script — went red on master with 6-9 failures,
// every one of them a TIMEOUT in these same tree-scanning / real-git suites. A red master gate
// withholds every merge board-wide, including diffs that touch none of it. Measured while loaded:
// migration-renumber-conflict-guard used 19.1s of its 20s budget, and git-service.integration took
// 304s wall for a file whose tests pass. The budget was measuring CPU contention, not correctness,
// which is the one thing a merge gate must never do. 60s restores real headroom without hiding a
// hang (a hang still never finishes). Heavier real-git suites set their own budget on top.
//
// `maxWorkers`/`minWorkers` are TOP-LEVEL in vitest 4 — see the note in
// packages/server/vitest.config.ts. The v3 `poolOptions.forks` form is ignored with a warning.
const cpuCount = os.cpus().length || 4;
const maxWorkers = Number(process.env.VITEST_MAX_WORKERS) || Math.max(2, Math.floor(cpuCount / 2));
const testTimeout = Number(process.env.VITEST_TEST_TIMEOUT) || 60_000;

export default defineConfig({
  test: {
    globals: true,
    // #285 — git committer identity via env, so no fixture pays two `git config` spawns.
    setupFiles: [path.resolve(__dirname, "../../test-setup/git-identity.ts")],
    exclude: ["**/dist/**", "**/node_modules/**"],
    testTimeout,
    hookTimeout: testTimeout,
    pool: "forks",
    maxWorkers,
    minWorkers: 1,
  },
});
