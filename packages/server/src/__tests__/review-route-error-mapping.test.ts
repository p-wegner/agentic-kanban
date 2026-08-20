// @covers server.startup.route-setup.reviewRoute [error-handling, contract]
// @covers server.middleware.error-handler.refusalCodes [error-handling, contract]
//
// #683 / #692 — two halves of one defect: an error whose status was decided by the WRONG
// mapper, and refusal reasons the RIGHT mapper dropped.
//
// `POST /api/workspaces/:id/review` is registered in `route-setup.ts` BEFORE
// `app.route("/api", createRoutes(...))`, so Hono resolves it first and its own catch-all
// (`{code:"INTERNAL"}`, 500) won over `domainErrorHandler`. `startManualReview` rethrows
// `startSession`'s errors unchanged, so every one of them became a 500: a stale safety policy
// lost both its 409 and the `staleFiles` payload the UI and monitor branch on, and strict
// worker dispatch with no live worker reported an internal error instead of a retryable 503.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { domainErrorHandler } from "../middleware/error-handler.js";
import { WorkspaceError } from "../services/workspace-internals.js";
import { WorkerDispatchUnavailableError } from "../services/agent-dispatch.service.js";

/**
 * The route's error path in isolation: the ReviewError branch is this endpoint's own contract
 * and stays, everything else delegates. Mirrors `route-setup.ts`'s catch shape so a
 * regression there shows up here.
 */
function appThrowing(err: unknown) {
  const app = new Hono();
  app.post("/api/workspaces/:id/review", async (c) => {
    try {
      throw err;
    } catch (e) {
      if (e instanceof Error) return domainErrorHandler(e, c);
      return c.json({ error: String(e), code: "INTERNAL" }, 500);
    }
  });
  return app;
}

async function post(err: unknown) {
  const res = await appThrowing(err).request("/api/workspaces/w1/review", { method: "POST" });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("review route error mapping (#683)", () => {
  it("a stale safety policy is a 409 that keeps its staleFiles payload", async () => {
    const { status, body } = await post(
      new WorkspaceError("stale safety files", "CONFLICT", {
        code: "STALE_SAFETY_POLICY",
        staleFiles: [".claude/hooks/validate-command-safety.js"],
      }),
    );

    expect(status).toBe(409);
    expect(body.code).toBe("STALE_SAFETY_POLICY");
    expect(body.staleFiles).toEqual([".claude/hooks/validate-command-safety.js"]);
  });

  // The #692 defect in its own right: a field-initializer code absent from every status table.
  it("strict worker dispatch with no live worker is a retryable 503, not a 500", async () => {
    const { status, body } = await post(new WorkerDispatchUnavailableError("no worker can take this"));

    expect(status).toBe(503);
    expect(body.code).toBe("NO_AVAILABLE_WORKER");
    expect(body.error).toContain("no worker");
  });

  it("a profile-allowlist hold reaches the client WITH its reason, not just a 409 sentence", async () => {
    const { status, body } = await post(
      new WorkspaceError("Profile allowlist blocks this launch", "CONFLICT", {
        code: "PROFILE_ALLOWLIST_HOLD",
        projectId: "p1",
      }),
    );

    expect(status).toBe(409);
    expect(body.code).toBe("PROFILE_ALLOWLIST_HOLD");
  });

  it("an unrecognised error still falls through to a 500, so nothing is silently promoted", async () => {
    const { status, body } = await post(new Error("something genuinely unexpected"));

    expect(status).toBe(500);
    expect(body.error).toContain("something genuinely unexpected");
  });

  it("a WorkspaceError with no refusal code keeps the status from its own code", async () => {
    const { status } = await post(new WorkspaceError("nope", "NOT_FOUND"));
    expect(status).toBe(404);
  });
});
