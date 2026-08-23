// @covers server.middleware.error-handler.codeEcho [error-handling, contract]
//
// #823 — `domainErrorHandler` decided the STATUS from a domain `code` and then threw the
// code away, so the body carried prose only. That is what made #821's conversion of the
// review route's inline bodies non-behaviour-preserving, measured live:
//
//     inline body:      404  {"error":"Workspace not found","code":"NOT_FOUND"}
//     via middleware:   404  {"error":"Workspace not found"}
//
// The lesson carried over from #821 is that `review-route-error-mapping.test.ts` stayed
// GREEN through exactly that regression: it exercises only the delegation path
// (`WorkspaceError`, `WorkerDispatchUnavailableError`, plain `Error`) and never the
// `ReviewError` branches that actually carry `code`. This suite is the missing half — it
// asserts the BODY of every branch that now echoes a code, and the branches that must NOT.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { domainErrorHandler } from "../middleware/error-handler.js";
import {
  AppError,
  AiOperationError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from "../errors/index.js";
import { WorkspaceError } from "../services/workspace-internals.js";
import { ReviewError } from "../services/review.service.js";

function appThrowing(err: unknown) {
  const app = new Hono();
  app.post("/x", async (c) => {
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
  const res = await appThrowing(err).request("/x", { method: "POST" });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A service-local coded error — the shape every `XxxError extends Error` in `services/` has. */
class FakeServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly index?: number,
  ) {
    super(message);
  }
}

describe("error-handler echoes the domain code into the body (#823)", () => {
  // ─────────── the generic domain-code branch ───────────

  it.each([
    ["NOT_FOUND", 404],
    ["CONFLICT", 409],
    ["FORBIDDEN", 403],
    ["BAD_REQUEST", 400],
    ["VALIDATION_ERROR", 400],
    ["UNPROCESSABLE", 422],
    ["INVALID_DATA", 400],
    ["INTERNAL", 500],
    ["AI_ERROR", 500],
  ])("a coded service error answers %s with that code in the body", async (code, expected) => {
    const { status, body } = await post(new FakeServiceError("nope", code));
    expect(status).toBe(expected);
    expect(body).toEqual({ error: "nope", code });
  });

  it("keeps the batch `index` field alongside the code", async () => {
    const { status, body } = await post(new FakeServiceError("entry 2 failed", "BAD_REQUEST", 2));
    expect(status).toBe(400);
    expect(body).toEqual({ error: "entry 2 failed", code: "BAD_REQUEST", index: 2 });
  });

  // The narrowing this branch has always done, now load-bearing for the BODY too: an
  // arbitrary `code` must not become a wire field. A Node system error is the real case.
  it("does not echo an UNRECOGNISED code — ENOENT is still a bare 500", async () => {
    const { status, body } = await post(new FakeServiceError("no such file", "ENOENT"));
    expect(status).toBe(500);
    expect(body.code).toBeUndefined();
    expect(body).toEqual({ error: "no such file" });
  });

  // ─────────── the ReviewError branches #821 never covered ───────────

  it.each([
    ["NOT_FOUND", 404],
    ["BAD_REQUEST", 400],
    ["CONFLICT", 409],
  ] as const)("a ReviewError(%s) maps to %i WITH its code", async (code, expected) => {
    const { status, body } = await post(new ReviewError("review says no", code));
    expect(status).toBe(expected);
    expect(body).toEqual({ error: "review says no", code });
  });

  // ─────────── AppError ───────────

  it.each([
    [new NotFoundError("gone"), 404, "NOT_FOUND"],
    [new ValidationError("bad field"), 400, "VALIDATION_ERROR"],
    [new UnprocessableError("cannot act"), 422, "UNPROCESSABLE"],
    [new ConflictError("already there"), 409, "CONFLICT"],
    [new ForbiddenError("not yours"), 403, "FORBIDDEN"],
  ])("%#: an AppError subclass carries its code into the body", async (err, expected, code) => {
    const { status, body } = await post(err);
    expect(status).toBe(expected);
    expect(body).toEqual({ error: (err as AppError).message, code });
  });

  // ─────────── shapes that deliberately DO NOT gain a code ───────────

  it("an HTTPException body is unchanged — it has no domain code to echo", async () => {
    const { status, body } = await post(new HTTPException(418, { message: "teapot" }));
    expect(status).toBe(418);
    expect(body).toEqual({ error: "teapot" });
  });

  it("AiOperationError keeps its bespoke detail shape and does not gain a code", async () => {
    // It is an AppError, but its own branch runs first — asserted so a future reorder of
    // the branches cannot silently change this response.
    const { status, body } = await post(new AiOperationError("claude failed", "stderr text"));
    expect(status).toBe(500);
    expect(body).toEqual({ error: "claude failed", detail: "stderr text" });
  });

  it("a merge-reason WorkspaceError keeps its {reason,message} shape", async () => {
    const { status, body } = await post(
      new WorkspaceError("cannot merge", "CONFLICT", { mergeReason: "merge_conflict", conflictFiles: ["a.ts"] }),
    );
    expect(status).toBe(409);
    expect(body).toEqual({ reason: "merge_conflict", message: "cannot merge", conflictFiles: ["a.ts"] });
  });

  it("a plain WorkspaceError with no refusal code now also carries its own code", async () => {
    // Previously a bare 404 with prose only: WorkspaceError's `code` IS a domain code, so
    // it reaches the generic branch and is echoed like any other.
    const { status, body } = await post(new WorkspaceError("workspace gone", "NOT_FOUND"));
    expect(status).toBe(404);
    expect(body).toEqual({ error: "workspace gone", code: "NOT_FOUND" });
  });

  it("an uncoded Error is still a bare 500 — nothing is invented", async () => {
    const { status, body } = await post(new Error("kaboom"));
    expect(status).toBe(500);
    expect(body).toEqual({ error: "kaboom" });
  });

  it("a legacy numeric statusCode with no code stays codeless", async () => {
    const { status, body } = await post(Object.assign(new Error("legacy"), { statusCode: 402 }));
    expect(status).toBe(402);
    expect(body).toEqual({ error: "legacy" });
  });

  // The second finding #821 recorded, kept as an executable fact: a NON-Error throw never
  // reaches `onError` at all (Hono's `compose` rethrows it), so a route's
  // `c.json({ error: String(err), code: "INTERNAL" }, 500)` catch-all is NOT redundant with
  // this middleware and must not be deleted as dead.
  it("a non-Error throw never reaches the middleware", async () => {
    const app = new Hono();
    app.onError((err, c) => domainErrorHandler(err, c));
    app.post("/y", async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw { code: "NOT_FOUND", message: "not an Error instance" };
    });
    await expect(app.request("/y", { method: "POST" })).rejects.toBeTruthy();
  });
});
