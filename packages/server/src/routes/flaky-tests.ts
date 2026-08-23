import type { Database } from "../db/index.js";
import { createTestRunService, parseTestOutput } from "../services/test-run.service.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody, parseOptionalJsonBody } from "../middleware/parse-body.js";
import { flakyParseBody, flakyPinBody } from "./flaky-test-body-schemas.js";

export function createFlakyTestsRoute(database: Database) {
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
    const body = await parseJsonBody(c, flakyParseBody);
    const records = parseTestOutput(body.output, body.runner);
    if (records.length === 0) {
      return c.json({ inserted: 0, message: "no parseable test results found" });
    }
    await svc.recordRuns(
      records.map(r => ({
        ...r,
        sessionId: body.sessionId,
        commitSha: body.commitSha,
      })),
    );
    return c.json({ inserted: records.length });
  });

  // POST /api/flaky-tests/pin — pin a test as known-flaky
  router.post("/pin", async (c) => {
    const body = await parseJsonBody(c, flakyPinBody);
    await svc.pinTest(body.testName, body.file);
    return c.json({ ok: true });
  });

  // DELETE /api/flaky-tests/pin — unpin a test
  router.delete("/pin", async (c) => {
    // #806 batch 3 REJECTED converting this read: `parseOptionalJsonBody` answers `{}` for a
    // MISSING body, so an empty DELETE reaches the `testName is required` 400 below.
    // `parseJsonBody` would answer `invalid JSON body` instead — a different message for the
    // same request. (The note lives INSIDE the handler on purpose: the OpenAPI generator takes
    // the last comment line above a route as its summary.)
    const body = await parseOptionalJsonBody<{ testName?: string }>(c);
    if (!body.testName) return c.json({ error: "testName is required" }, 400);
    await svc.unpinTest(body.testName);
    return c.json({ ok: true });
  });

  return router;
}
