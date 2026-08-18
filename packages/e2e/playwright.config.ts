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
const systemLane = process.env.KANBAN_E2E_SYSTEM === "1";
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
    // No lane spends real agent quota unless asked to: KANBAN_E2E_REAL_AGENT=1 is the ONLY
    // way to get a real provider, including in the @system lane. Several @system specs turn
    // out to need nothing more than a launched session, which the mock supplies — the tag
    // marks specs that were never run, not specs that provably require a live agent.
    ...(process.env.KANBAN_E2E_REAL_AGENT === "1" ? {} : { MOCK_AGENT: "1" }),
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
  // Three lanes over ONE spec tree (#645):
  //   default          — everything that is not @system
  //   `test:e2e:smoke` — `--grep @smoke`, the core-flow subset, cheap enough to run often
  //   `test:e2e:system`— KANBAN_E2E_SYSTEM=1, the specs that need a real agent provider
  // The @system lane needed a config EDIT before ("remove this line and use --grep @system"),
  // which is why nobody ran it and its specs rotted unnoticed. It is a command now.
  ...(systemLane ? { grep: /@system/ } : { grepInvert: /@system/ }),
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  use: {
    baseURL: `http://127.0.0.1:${clientPort}`,
    // Playwright's own Chromium, not the system Chrome (#645). `channel: "chrome"` made
    // all 68 UI specs fail with "Chromium distribution 'chrome' is not found" on a machine
    // that simply has Chrome installed elsewhere — an unrunnable suite by default. Set
    // KANBAN_E2E_CHANNEL=chrome to test against a real branded Chrome deliberately.
    ...(process.env.KANBAN_E2E_CHANNEL ? { channel: process.env.KANBAN_E2E_CHANNEL } : {}),
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
      // The server's own log is the fastest way to explain a failing spec, but it is far
      // louder than the test output — opt in with KANBAN_E2E_SERVER_LOG=1.
      ...(process.env.KANBAN_E2E_SERVER_LOG === "1" ? { stdout: "pipe", stderr: "pipe" } : {}),
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
