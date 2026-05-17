import { defineConfig } from "@playwright/test";

const serverPort = Number(process.env.SERVER_PORT) || 3001;
const clientPort = Number(process.env.VITE_PORT) || 5173;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: 0,
  globalSetup: "./global-setup.ts",
  use: {
    baseURL: `http://localhost:${clientPort}`,
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
