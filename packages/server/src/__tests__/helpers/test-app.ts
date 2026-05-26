import { Hono } from "hono";
import { createTestDb, type TestDb } from "./test-db.js";

/**
 * Creates a Hono app backed by an in-memory DB with all migrations applied.
 * Pass a routeSetup callback to mount routes onto the app.
 */
export function createTestApp(
  routeSetup: (app: Hono, db: TestDb) => void,
): { app: Hono; db: TestDb } {
  const { db } = createTestDb();
  const app = new Hono();
  routeSetup(app, db);
  return { app, db };
}
