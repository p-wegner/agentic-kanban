// @covers workspaces.review.errorBodies [error-handling, contract, api]
//
// #823 — the REAL route handler, not a re-creation of its catch block.
//
// `review-route-error-mapping.test.ts` mirrors the route's catch shape in a local helper.
// That is what let it stay green while the two `ReviewError` branches it does not model
// carried a `code` the middleware dropped (#821). This suite drives
// `createWorkspaceReviewRoute` itself with `startManualReview` stubbed to throw, so the
// bodies asserted here are the ones the endpoint actually answers with.
//
// It also pins the EQUIVALENCE the ratchet comment relies on: these are exactly the bodies
// `domainErrorHandler` produces post-#823 for the same errors (see
// `error-handler-code-echo.test.ts`), which is what makes the conversion #821 wanted
// behaviour-preserving. The conversion is still not made — the OpenAPI generator reads
// literal `c.json(body, status)` sites and delegating would delete the endpoint's
// documented 404/400 from `openapi.yaml`. If someone teaches the generator about thrown
// domain errors and converts, THESE assertions must not change.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const startManualReview = vi.fn();

vi.mock("../services/review.service.js", async (importOriginal) => {
  // ReviewError itself must stay REAL — the route branches on `instanceof`.
  const actual = await importOriginal<typeof import("../services/review.service.js")>();
  return { ...actual, startManualReview };
});

const { ReviewError } = await import("../services/review.service.js");
const { createWorkspaceReviewRoute } = await import("../routes/workspace-review.js");

function app() {
  const a = new Hono();
  a.route(
    "/api/workspaces",
    createWorkspaceReviewRoute(
      {} as never,
      (() => ({})) as never,
      { boardEvents: { broadcast: () => {} } as never, reviewSessionIds: new Set<string>() },
    ),
  );
  return a;
}

async function post() {
  const res = await app().request("/api/workspaces/w1/review", { method: "POST" });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  startManualReview.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/workspaces/:id/review error bodies (#823)", () => {
  it("NOT_FOUND answers 404 WITH the code", async () => {
    startManualReview.mockRejectedValue(new ReviewError("Workspace not found", "NOT_FOUND"));
    // The exact pair #821 measured live. The inline body produced this; so must delegation.
    await expect(post()).resolves.toEqual({
      status: 404,
      body: { error: "Workspace not found", code: "NOT_FOUND" },
    });
  });

  it("BAD_REQUEST answers 400 WITH the code", async () => {
    startManualReview.mockRejectedValue(new ReviewError("workspace has no branch", "BAD_REQUEST"));
    await expect(post()).resolves.toEqual({
      status: 400,
      body: { error: "workspace has no branch", code: "BAD_REQUEST" },
    });
  });

  it("CONFLICT keeps its request-shaped payload — it can never be delegated", async () => {
    startManualReview.mockRejectedValue(
      new ReviewError("a review is already running", "CONFLICT", {
        workspaceStatus: "reviewing",
        retryable: true,
        activeSessionId: "s-1",
        activeTriggerType: null,
        conflictFiles: ["a.ts"],
      }),
    );
    const { status, body } = await post();
    expect(status).toBe(409);
    expect(body).toEqual({
      error: "a review is already running",
      code: "CONFLICT",
      workspaceStatus: "reviewing",
      retryable: true,
      activeSessionId: "s-1",
      activeTriggerType: null,
      conflictFiles: ["a.ts"],
    });
  });

  it("a non-ReviewError still reaches the mapper (the #683 delegation)", async () => {
    const { WorkerDispatchUnavailableError } = await import("../services/agent-dispatch.service.js");
    startManualReview.mockRejectedValue(new WorkerDispatchUnavailableError("no worker can take this"));
    const { status, body } = await post();
    expect(status).toBe(503);
    expect(body.code).toBe("NO_AVAILABLE_WORKER");
  });
});
