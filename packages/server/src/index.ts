import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { createRoutes } from "./routes/index.js";
import { createSessionsRoute } from "./routes/sessions.js";
import { migrate } from "drizzle-orm/libsql/migrator";
import { db } from "./db/index.js";
import { createSessionManager } from "./services/session.manager.js";
import { createBoardEvents } from "./services/board-events.js";
import { workspaces, issues } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";

const app = new Hono();

// Middleware
app.use("/api/*", cors());

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// WebSocket setup
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// Board events service
const boardEvents = createBoardEvents(upgradeWebSocket);

// Session manager with onSessionExit callback
const sessionManager = createSessionManager(upgradeWebSocket, {
  onSessionExit: async (workspaceId: string) => {
    try {
      // Resolve projectId from workspaceId → issue → project
      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
      if (wsRows.length === 0) return;
      const issueRows = await db.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, wsRows[0].issueId)).limit(1);
      if (issueRows.length === 0) return;
      boardEvents.broadcast(issueRows[0].projectId, "session_completed");
    } catch (err) {
      console.error("Failed to broadcast session exit:", err);
    }
  },
});

// Mount WebSocket routes
app.get(
  "/ws/sessions/:sessionId",
  sessionManager.wsRoute(),
);
app.get(
  "/ws/board/:projectId",
  boardEvents.wsRoute(),
);

// API routes (with boardEvents for real-time updates)
app.route("/api", createRoutes(db, () => sessionManager, { boardEvents }));

// Session output route
app.route("/api/sessions", createSessionsRoute(db));

// Start server
const port = Number(process.env.PORT) || 3001;

// Run migrations on startup
await migrate(db, { migrationsFolder: "../shared/drizzle" });

console.log(`Server starting on port ${port}...`);
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server running at http://localhost:${info.port}`);
});

// Inject WebSocket handler into the HTTP server
injectWebSocket(server);

export default app;
export { sessionManager };
