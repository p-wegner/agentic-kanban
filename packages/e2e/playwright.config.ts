import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: "http://localhost:5173",
  },
  webServer: [
    {
      command: "pnpm --filter @agentic-kanban/server dev",
      port: 3001,
      reuseExistingServer: true,
      cwd: "../..",
    },
    {
      command: "pnpm --filter @agentic-kanban/client dev",
      port: 5173,
      reuseExistingServer: true,
      cwd: "../..",
    },
  ],
});
