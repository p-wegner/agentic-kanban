import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      "@agentic-kanban/shared": path.resolve(__dirname, "../shared/src"),
    },
  },
});
