import { defineConfig } from "vitest/config";
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
// `maxWorkers`/`minWorkers` are TOP-LEVEL in vitest 4 — see the note in
// packages/server/vitest.config.ts. The v3 `poolOptions.forks` form is ignored with a warning.
const cpuCount = os.cpus().length || 4;
const maxWorkers = Number(process.env.VITEST_MAX_WORKERS) || Math.max(2, Math.floor(cpuCount / 2));
const testTimeout = Number(process.env.VITEST_TEST_TIMEOUT) || 20_000;

export default defineConfig({
  test: {
    globals: true,
    exclude: ["**/dist/**", "**/node_modules/**"],
    testTimeout,
    hookTimeout: testTimeout,
    pool: "forks",
    maxWorkers,
    minWorkers: 1,
  },
});
