import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { createFlakeClassifierService } from "../services/flake-classifier.service.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { createRouter } from "../middleware/create-router.js";

export function createFlakyTestsRoute(database: Database = db) {
  const router = createRouter();
  const service = createFlakeClassifierService(database);

  // ─── Flaky Test Registry ─────────────────────────────────────────────────

  // GET /api/projects/:projectId/flaky-tests
  router.get("/:projectId/flaky-tests", async (c) => {
    const projectId = c.req.param("projectId");
    const result = await service.listFlakyTests(projectId);
    return c.json(result);
  });

  // POST /api/projects/:projectId/flaky-tests
  router.post("/:projectId/flaky-tests", async (c) => {
    const projectId = c.req.param("projectId");
    const body = await parseJsonBody<{
      testName?: string;
      testFilePath?: string;
      errorPattern?: string;
      reason?: string;
    }>(c);
    if (!body.testName) return c.json({ error: "testName is required" }, 400);
    const result = await service.createFlakyTest({
      projectId,
      testName: body.testName,
      testFilePath: body.testFilePath,
      errorPattern: body.errorPattern,
      reason: body.reason,
    });
    return c.json(result, 201);
  });

  // DELETE /api/projects/:projectId/flaky-tests/:testId
  router.delete("/:projectId/flaky-tests/:testId", async (c) => {
    await service.deleteFlakyTest(c.req.param("testId"));
    return c.json({ success: true });
  });

  // ─── Classifier ───────────────────────────────────────────────────────────

  // POST /api/projects/:projectId/classify-test
  router.post("/:projectId/classify-test", async (c) => {
    const projectId = c.req.param("projectId");
    const body = await parseJsonBody<{
      testName?: string;
      errorMessage?: string;
      stackTrace?: string;
      changedFiles?: string[];
      testFilePath?: string;
      sessionId?: string;
      workspaceId?: string;
    }>(c);
    if (!body.testName) return c.json({ error: "testName is required" }, 400);
    if (!body.sessionId) return c.json({ error: "sessionId is required" }, 400);
    if (!body.workspaceId) return c.json({ error: "workspaceId is required" }, 400);

    const result = await service.classifyFailure({
      testName: body.testName,
      errorMessage: body.errorMessage,
      stackTrace: body.stackTrace,
      changedFiles: body.changedFiles ?? [],
      testFilePath: body.testFilePath,
      projectId,
      sessionId: body.sessionId,
      workspaceId: body.workspaceId,
    });
    return c.json(result);
  });

  // ─── Telemetry ────────────────────────────────────────────────────────────

  // GET /api/projects/:projectId/flaky-tests/telemetry
  router.get("/:projectId/flaky-tests/telemetry", async (c) => {
    const projectId = c.req.param("projectId");
    const result = await service.getTelemetry(projectId);
    return c.json(result);
  });

  return router;
}

export function createWorkspaceFlakyTestsRoute(database: Database = db) {
  const router = createRouter();
  const service = createFlakeClassifierService(database);

  // GET /api/workspaces/:workspaceId/retry-decisions
  router.get("/:workspaceId/retry-decisions", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const result = await service.getDecisionsForWorkspace(workspaceId);
    return c.json(result);
  });

  // PATCH /api/workspaces/:workspaceId/retry-decisions/:decisionId
  router.patch("/:workspaceId/retry-decisions/:decisionId", async (c) => {
    const decisionId = c.req.param("decisionId");
    const body = await parseJsonBody<{
      outcome?: "passed" | "failed";
      retryCount?: number;
      maxRetries?: number;
    }>(c);
    if (!body.outcome) return c.json({ error: "outcome is required" }, 400);
    if (body.retryCount === undefined) return c.json({ error: "retryCount is required" }, 400);
    const maxRetries = body.maxRetries ?? 2;
    const result = await service.recordRetryOutcome(decisionId, body.outcome, body.retryCount, maxRetries);
    return c.json(result);
  });

  return router;
}

export function createSessionFlakyTestsRoute(database: Database = db) {
  const router = createRouter();
  const service = createFlakeClassifierService(database);

  // GET /api/sessions/:sessionId/retry-decisions
  router.get("/:sessionId/retry-decisions", async (c) => {
    const sessionId = c.req.param("sessionId");
    const result = await service.getDecisionsForSession(sessionId);
    return c.json(result);
  });

  return router;
}
