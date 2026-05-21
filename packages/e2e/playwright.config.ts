import { defineConfig } from "@playwright/test";
import * as path from "path";
import * as os from "os";

const serverPort = Number(process.env.SERVER_PORT) || 3001;
const clientPort = Number(process.env.VITE_PORT) || 5173;

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

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: 0,
  globalSetup: "./global-setup.ts",
  use: {
    baseURL: `http://localhost:${clientPort}`,
<<<<<<< HEAD
    channel: "chrome",
=======
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
>>>>>>> 2c93de4 (feat: add preference API tests for auto_review and review_auto_fix)
  },
  webServer: [
    {
      command: "pnpm --filter agentic-kanban dev",
      port: serverPort,
      reuseExistingServer: true,
      cwd: "../..",
    },
    {
      command: "pnpm --filter @agentic-kanban/client dev",
      port: clientPort,
      reuseExistingServer: true,
      cwd: "../..",
    },
  ],
});
