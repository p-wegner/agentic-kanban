import { Hono } from "hono";
import { db } from "../db/index.js";
import { sessionMessages, sessions } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";

export function createSessionsRoute(database: Database = db) {
  const router = new Hono();

  // GET /api/sessions/:sessionId/output
  router.get("/:sessionId/output", async (c) => {
    const sessionId = c.req.param("sessionId");

    // Check session exists
    const sessionRows = await database
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (sessionRows.length === 0) {
      return c.json({ error: "Session not found" }, 404);
    }

    const rows = await database
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(sessionMessages.id);

    const messages: AgentOutputMessage[] = rows.map((row) => ({
      type: row.type as "stdout" | "stderr" | "exit",
      sessionId: row.sessionId,
      data: row.data ?? undefined,
      exitCode: row.exitCode != null ? Number(row.exitCode) : undefined,
    }));

    return c.json(messages);
  });

  return router;
}
