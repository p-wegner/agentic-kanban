import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@agentic-kanban/shared/schema";

// Resolve DB path: prefer env var, then try relative to this file (monorepo dev), then CWD
function resolveDbPath(): string {
  if (process.env.DB_URL) return process.env.DB_URL;
  // Monorepo dev: ../../server/kanban.db relative to this file
  const devPath = resolve(import.meta.dirname, "../../server/kanban.db");
  if (existsSync(devPath)) return devPath;
  // Published/fallback: kanban.db in current working directory
  return resolve(process.cwd(), "kanban.db");
}

const dbPath = resolveDbPath();
const url = dbPath.startsWith("file:") ? dbPath : `file:${dbPath}`;

export const db = drizzle({ connection: { url }, schema });
export { schema };
