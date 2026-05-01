import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { routes } from "./routes/index.js";
import { migrate } from "drizzle-orm/libsql/migrator";
import { db } from "./db/index.js";

const app = new Hono();

// Middleware
app.use("/api/*", cors());

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// API routes
app.route("/api", routes);

// Start server
const port = Number(process.env.PORT) || 3001;

// Run migrations on startup
await migrate(db, { migrationsFolder: "../shared/drizzle" });

console.log(`Server starting on port ${port}...`);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server running at http://localhost:${info.port}`);
});

export default app;
