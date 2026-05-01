import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "turso",
  schema: "../shared/src/schema/index.ts",
  out: "../shared/drizzle",
  dbCredentials: {
    url: "file:kanban.db",
  },
});
