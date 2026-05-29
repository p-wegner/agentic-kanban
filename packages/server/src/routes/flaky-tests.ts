import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { createTestRunService, parseTestOutput } from "../services/test-run.service.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody, parseOptionalJsonBody } from "../middleware/parse-body.js";

export function createFlakyTestsRoute(database: Database = db) {
  const router = createRouter();
  const svc = createTestRunService(database);

  // GET /api/flaky-tests — list flaky tests
  router.get("/", async (c) => {
    const limit = Number(c.req.query("limit") ?? "50");
    const minRuns = Number(c.req.query("minRuns") ?? "5");
    const windowDays = Number(c.req.query("windowDays") ?? "30");
    const flaky = await svc.getFlaky({ limit, minRuns, windowDays });
    return c.json(flaky);
  });

  // GET /api/flaky-tests/pinned — list pinned (known-flaky) tests
  router.get("/pinned", async (c) => {
    return c.json(await svc.getPinnedTests());
  });

  // POST /api/flaky-tests/parse — ingest test output JSON
  router.post("/parse", async (c) => {
    const body = await parseJsonBody(c) as {
      sessionId?: string;
      commitSha?: string;
      output?: string;
      runner?: "vitest" | "playwright";
    };
    if (!body.sessionId || !body.output) {
      return c.json({ error: "sessionId and output are required" }, 400);
    }
    const records = parseTestOutput(body.output, body.runner);
    if (records.length === 0) {
      return c.json({ inserted: 0, message: "no parseable test results found" });
    }
    await svc.recordRuns(
      records.map(r => ({
        ...r,
        sessionId: body.sessionId!,
        commitSha: body.commitSha,
      })),
    );
    return c.json({ inserted: records.length });
  });

  // POST /api/flaky-tests/pin — pin a test as known-flaky
  router.post("/pin", async (c) => {
    const body = await parseJsonBody(c) as { testName?: string; file?: string };
    if (!body.testName) return c.json({ error: "testName is required" }, 400);
    await svc.pinTest(body.testName, body.file);
    return c.json({ ok: true });
  });

  // DELETE /api/flaky-tests/pin — unpin a test
  router.delete("/pin", async (c) => {
    const body = await parseOptionalJsonBody<{ testName?: string }>(c);
    if (!body.testName) return c.json({ error: "testName is required" }, 400);
    await svc.unpinTest(body.testName);
    return c.json({ ok: true });
  });

  return router;
}
