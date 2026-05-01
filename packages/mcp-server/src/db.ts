import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@agentic-kanban/shared/schema";

// Resolve DB path: prefer env var, otherwise use ../../server/kanban.db relative to this file
const dbPath = process.env.DB_URL || resolve(import.meta.dirname, "../../server/kanban.db");
const url = dbPath.startsWith("file:") ? dbPath : `file:${dbPath}`;

export const db = drizzle({ connection: { url }, schema });
export { schema };
