import { defineConfig } from "@playwright/test";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const serverPort = Number(process.env.SERVER_PORT) || 3001;
const clientPort = Number(process.env.VITE_PORT) || 5173;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Use full chromium if headless-shell is not installed (avoids lock file issues on Windows)
const headlessShellPath = path.join(
  os.homedir(),
  "AppData/Local/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-win64/chrome-headless-shell.exe"
);
const chromiumPath = path.join(
  os.homedir(),
  "AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe"
);
import * as fs from "fs";
const executablePath = fs.existsSync(headlessShellPath) ? headlessShellPath : (fs.existsSync(chromiumPath) ? chromiumPath : undefined);
function commandWithEnv(envKey: string, envValue: string, command: string[]) {
  return ["node", "packages/e2e/web-server.mjs", envKey, envValue, ...command].join(" ");
}

const serverCommand = commandWithEnv("PORT", String(serverPort), ["pnpm", "--filter", "agentic-kanban", "dev"]);
const clientCommand = commandWithEnv("VITE_PORT", String(clientPort), ["pnpm", "--filter", "@agentic-kanban/client", "dev"]);

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: 0,
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
      reuseExistingServer: true,
      cwd: repoRoot,
    },
    {
      command: clientCommand,
      url: `http://127.0.0.1:${clientPort}`,
      reuseExistingServer: true,
      cwd: repoRoot,
    },
  ],
});
