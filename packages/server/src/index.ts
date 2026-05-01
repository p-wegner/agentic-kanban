import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { routes } from "./routes/index.js";
import { createWorkspaceActionsRoute } from "./routes/workspace-actions.js";
import { migrate } from "drizzle-orm/libsql/migrator";
import { db } from "./db/index.js";
import { createSessionManager } from "./services/session.manager.js";

const app = new Hono();

// Middleware
app.use("/api/*", cors());

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// WebSocket setup
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// Session manager
const sessionManager = createSessionManager(upgradeWebSocket);

// Mount WebSocket session route
app.get(
  "/ws/sessions/:sessionId",
  sessionManager.wsRoute(),
);

// API routes (CRUD only — no workspace actions to avoid circular deps)
app.route("/api", routes);

// Workspace action routes (separate mount with lazy session manager access)
app.route("/api/workspaces", createWorkspaceActionsRoute(() => sessionManager, db));

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
