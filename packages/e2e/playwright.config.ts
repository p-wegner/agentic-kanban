import { defineConfig } from "@playwright/test";
import * as path from "path";
import { fileURLToPath } from "url";
import { E2E_CLIENT_PORT, E2E_SERVER_PORT } from "./ports.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * E2E runs on its OWN ports and its OWN database (#645).
 *
 * Before: the ports defaulted to 3001/5173 with `reuseExistingServer: true`, and the
 * server inherited the ambient `AGENTIC_KANBAN_DIR`. So `pnpm test:e2e` on a dev machine
 * did not start an isolated stack at all — it ATTACHED to the live dev board, then
 * `global-setup` registered a project into its database and switched its active-project
 * preference. Teardown restores that, but only if the run reaches teardown; a crash or a
 * Ctrl-C left the developer's board pointing at an "E2E Test Project".
 *
 * The pre-merge gate solved this same problem with `AGENTIC_KANBAN_DIR` isolation (#231);
 * this is the E2E equivalent. `SERVER_PORT`/`VITE_PORT`/`AGENTIC_KANBAN_DIR` still
 * override, so CI or a debugging session can point the run wherever it likes — the
 * DEFAULT is what changed, because the default is what people run.
 */
const serverPort = E2E_SERVER_PORT;
const clientPort = E2E_CLIENT_PORT;
const dataDir = process.env.AGENTIC_KANBAN_DIR || path.join(repoRoot, "packages", "e2e", ".e2e-data");

function commandWithEnv(env: Record<string, string>, command: string[]) {
  const assignments = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  return ["node", "packages/e2e/web-server.mjs", ...assignments, "--", ...command].join(" ");
}

// The client's vite proxy targets SERVER_PORT too, so it must be told the same port —
// otherwise the browser talks to whatever sits on 3001, which is the bug above wearing
// a different hat.
// `dev:e2e`, not `dev`: `dev` boots the tsx-WATCH dev proxy, which owns the public port and
// forwards to a backend on port+10000. Under Playwright that backend never came up — the proxy
// bound 3901 immediately and then answered /health with 503 (10s per probe) until the run timed
// out. E2E has no use for hot reload anyway, and a watch-restart mid-suite is a flake source, so
// the suite boots the server process directly on its own port (#645).
const serverCommand = commandWithEnv(
  {
    SERVER_PORT: String(serverPort),
    AGENTIC_KANBAN_DIR: dataDir,
    // Without this the E2E server's startup sweep reaps every other server booted from
    // this checkout — i.e. the developer's own `pnpm dev` — as a hot-reload orphan (#645).
    KANBAN_SKIP_ORPHAN_CLEANUP: "1",
  },
  ["pnpm", "--filter", "agentic-kanban", "run", "dev:e2e"],
);
const clientCommand = commandWithEnv(
  { VITE_PORT: String(clientPort), SERVER_PORT: String(serverPort) },
  ["pnpm", "--filter", "@agentic-kanban/client", "dev"],
);

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: 0,
  // Exclude @system tests by default — they require a real agent provider.
  // To run only system tests: remove this line and use --grep @system
  grepInvert: /@system/,
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  use: {
    baseURL: `http://127.0.0.1:${clientPort}`,
    channel: "chrome",
  },
  webServer: [
    {
      command: serverCommand,
      url: `http://127.0.0.1:${serverPort}/health`,
      // NEVER reuse: reuse is what let the suite adopt the live dev board. On the E2E
      // ports there is nothing legitimate to reuse, and a leftover process from a killed
      // run must fail loudly rather than serve the next run stale state.
      reuseExistingServer: false,
      // A cold isolated stack migrates and seeds a brand-new database before it listens.
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
      cwd: repoRoot,
    },
    {
      command: clientCommand,
      url: `http://127.0.0.1:${clientPort}`,
      reuseExistingServer: false,
      timeout: 120_000,
      cwd: repoRoot,
    },
  ],
});
