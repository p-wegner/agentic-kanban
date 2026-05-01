import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@agentic-kanban/shared/schema";

const DB_URL = process.env.DB_URL || "file:kanban.db";

export const db = drizzle({ connection: { url: DB_URL }, schema });
export { schema };

export type Database = ReturnType<typeof drizzle<typeof schema>>;
