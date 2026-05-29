import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import {
  findSimilarFailures,
  listPatterns,
  createPattern,
  ingestLearningFile,
  deletePattern,
} from "../services/failure-pattern.service.js";

export function createFailurePatternsRoute(database: Database = db) {
  const router = createRouter();

  // GET /api/failure-patterns — list all stored patterns
  router.get("/", async (c) => {
    return c.json(await listPatterns(database));
  });

  // GET /api/failure-patterns/search?q=<text>&limit=<n> — find similar failures
  router.get("/search", async (c) => {
    const q = c.req.query("q") ?? "";
    const limit = Math.min(parseInt(c.req.query("limit") ?? "3", 10) || 3, 10);
    if (!q.trim()) return c.json([]);
    const matches = await findSimilarFailures(q, limit, database);
    return c.json(matches.map(m => ({
      pattern: m.pattern,
      score: m.score,
      matchedKeywords: m.matchedKeywords,
    })));
  });

  // POST /api/failure-patterns — create a pattern manually
  router.post("/", async (c) => {
    const body = await parseJsonBody<{
      title: string;
      errorClass?: string;
      description?: string;
      rootCause?: string;
      fix?: string;
      sourceType?: string;
      sourceRef?: string;
    }>(c);
    if (!body.title?.trim()) return c.json({ error: "title is required" }, 400);
    const pattern = await createPattern({
      title: body.title,
      errorClass: body.errorClass ?? null,
      description: body.description ?? null,
      rootCause: body.rootCause ?? null,
      fix: body.fix ?? null,
      sourceType: body.sourceType ?? "manual",
      sourceRef: body.sourceRef ?? null,
    }, database);
    return c.json(pattern, 201);
  });

  // POST /api/failure-patterns/ingest — ingest a markdown file
  router.post("/ingest", async (c) => {
    const body = await parseJsonBody<{ filePath: string }>(c);
    if (!body.filePath?.trim()) return c.json({ error: "filePath is required" }, 400);
    const ingested = await ingestLearningFile(body.filePath, database);
    return c.json({ ingested });
  });

  // DELETE /api/failure-patterns/:id
  router.delete("/:id", async (c) => {
    await deletePattern(c.req.param("id"), database);
    return c.json({ ok: true });
  });

  return router;
}
