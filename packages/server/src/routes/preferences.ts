import { Hono } from "hono";
import { db } from "../db/index.js";
import { preferences } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";

export function createPreferencesRoute(database: Database = db) {
  const router = new Hono();

  // GET /api/preferences/active-project
  router.get("/active-project", async (c) => {
    const rows = await database
      .select()
      .from(preferences)
      .where(eq(preferences.key, "activeProjectId"))
      .limit(1);

    if (rows.length === 0) {
      return c.json({ projectId: null });
    }

    return c.json({ projectId: rows[0].value });
  });

  // PUT /api/preferences/active-project
  router.put("/active-project", async (c) => {
    const body = await c.req.json();
    const now = new Date().toISOString();

    await database
      .insert(preferences)
      .values({
        key: "activeProjectId",
        value: body.projectId ?? "",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: preferences.key,
        set: { value: body.projectId ?? "", updatedAt: now },
      });

    return c.json({ projectId: body.projectId });
  });

  return router;
}

export const preferencesRoute = createPreferencesRoute();
