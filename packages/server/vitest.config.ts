import { defineConfig } from "vitest/config";
import path from "node:path";
import os from "node:os";

// The server suite is heavy: many files spawn real git subprocesses, `pnpm`/`node`
// CLI children, and do real filesystem work. Vitest's default forks pool fans out to
// roughly one fork per CPU core, which on a developer machine that is ALSO running dev
// servers + other node processes oversubscribes the box. The result is CPU/IO
// starvation: tests that pass comfortably in isolation intermittently blow their
// timeouts in a full parallel run (the "load flakes" — ~14 `Test timed out` + the odd
// worker crash). The fix is to leave headroom and give heavy tests slack under load.
//
// Both knobs are env-overridable so a dedicated CI runner can opt back into full
// parallelism / tighter timeouts without touching this file.
//
// `maxWorkers`/`minWorkers` are TOP-LEVEL in vitest 4. They were `poolOptions.forks.maxForks`
// in v3, which v4 REMOVED — it prints a deprecation warning and IGNORES the block entirely, so
// every knob above was silently inert and the pool still fanned out to one fork per core. The
// headroom this file describes only actually took effect in #49. Keep these top-level: the
// failure mode is invisible (a passing config that does nothing), so re-nesting them would
// quietly undo it again.
// #206: 20s was still not enough headroom, and this suite is where it hurt most. `pnpm test:mine`
// is ALSO the merge verify_script, so when a loaded machine (several agent sessions at once) pushed
// 89 of 4165 server tests past their budget — every one a TIMEOUT, not an assertion — master's gate
// went red and withheld EVERY merge board-wide, including diffs touching none of this. The budget
// was measuring CPU contention rather than correctness, which is the one thing a merge gate must
// never do. 60s restores real headroom without hiding a hang (a hang still never finishes).
const cpuCount = os.cpus().length || 4;
const maxWorkers = Number(process.env.VITEST_MAX_WORKERS) || Math.max(2, Math.floor(cpuCount / 2));
const testTimeout = Number(process.env.VITEST_TEST_TIMEOUT) || 60_000;

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
  resolve: {
    alias: {
      "@agentic-kanban/shared": path.resolve(__dirname, "../shared/src"),
    },
  },
});
