import { defineConfig } from "drizzle-kit";
import { getDbUrl } from "./src/db/data-dir.js";

/**
 * Drizzle-kit CLI config (`drizzle-kit generate|migrate|studio|push`).
 *
 * `dbCredentials.url` MUST come from the shared resolver, never a literal path. It used
 * to be a hardcoded, CWD-relative `file:kanban.db`, which made drizzle-kit the one tool
 * on the board that ignored `DB_URL` / `AGENTIC_KANBAN_DIR` and the home-dir fallback:
 * a single `drizzle-kit migrate` run from `packages/server` CREATED a brand-new
 * schema-only `packages/server/kanban.db`. Once that file existed and had grown past
 * `db-path.ts`'s size floor (a fresh migrate run is already ~700 KB — comfortably past
 * it), EVERY later process resolved `local-checkout` and silently opened that EMPTY
 * database instead of the real one. The board then looks wiped: no projects, no issues.
 *
 * Routing through `getDbUrl()` means drizzle-kit targets exactly the database the server,
 * the CLI and the MCP server target — and can no longer mint a shadow DB in the checkout.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "../shared/src/schema/index.ts",
  out: "../shared/drizzle",
  dbCredentials: {
    url: getDbUrl(),
  },
});
