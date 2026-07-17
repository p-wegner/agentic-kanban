import { defineConfig } from "vitest/config";
import path from "node:path";
import os from "node:os";

// Mirrors packages/server/vitest.config.ts — this suite has the same shape of load and
// suffered the same "load flakes" (#46).
//
// Two costs make the default 5s budget a machine-load measurement rather than an
// assertion about correctness:
//   * Every tool test builds a fresh DB via createTestDb(), which replays ALL ~100
//     drizzle migrations. That is ~2s of legitimate work per test, before the tool
//     under test does anything.
//   * A few suites (mcp-tools, disabled-tools, get-context-boundary) launch a REAL
//     node+tsx server process, which is not a 5s operation on a cold Windows cache.
//
// Vitest's default pool fans out ~one worker per core, which oversubscribes a dev box
// that is also running dev servers / other agents. Tests then pass in isolation but blow
// their timeouts in a full parallel run — false red that trains everyone to ignore the
// gate. Leave headroom and give the tests slack under load.
//
// This is NOT papering over a hang: a genuine hang never completes, so it still trips
// the (raised) budget. Both knobs are env-overridable so a dedicated CI runner can opt
// back into full parallelism / tighter timeouts without touching this file.
const cpuCount = os.cpus().length || 4;
const maxForks = Number(process.env.VITEST_MAX_FORKS) || Math.max(2, Math.floor(cpuCount / 2));
const testTimeout = Number(process.env.VITEST_TEST_TIMEOUT) || 20_000;

export default defineConfig({
  test: {
    globals: true,
    exclude: ["**/dist/**", "**/node_modules/**"],
    testTimeout,
    hookTimeout: testTimeout,
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks,
        minForks: 1,
      },
    },
  },
  resolve: {
    alias: {
      "@agentic-kanban/shared": path.resolve(__dirname, "../shared/src"),
    },
  },
});
