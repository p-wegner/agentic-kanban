// @covers routes.issues.bodyValidation [contract, error-handling]
//
// #512. Ten `/api/issues` handlers swapped a ladder of hand-written
// `if (!body.x) return c.json({ error: "..." }, 400)` guards for zod schemas via the new
// `parseJsonBody(c, schema)` overload.
//
// The wire SHAPE was never at risk — `domainErrorHandler` renders an HTTPException as
// `{ error: message }` with its status, which is what the guards returned. What WAS at
// risk is the message TEXT: zod's defaults are "Required" / "Expected string, received
// number", and a refactor that quietly changed every 400 body on these endpoints would be
// a contract change wearing a refactor's clothes.
//
// So this suite asserts the exact strings, not merely `status === 400`. It is the whole
// point of the ticket being safe.
import { describe, it, expect, beforeAll } from "vitest";
import { createTestApp, createProjectDirectly } from "./helpers/api-test-helpers.js";

describe("POST/PATCH /api/issues body validation keeps its exact 400 messages (#512)", () => {
  const { app, db: database } = createTestApp();
  let projectId: string;

  beforeAll(async () => {
    projectId = await createProjectDirectly(database, { name: "Body Validation Project" });
  });

  async function post(path: string, body: unknown, method = "POST") {
    const res = await app.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { error?: string } };
  }

  const cases: Array<[name: string, path: string, body: unknown, message: string, method?: string]> = [
    ["enhance rejects a blank title", "/api/issues/enhance", { title: "   " }, "title is required"],
    ["enhance rejects a missing title", "/api/issues/enhance", {}, "title is required"],
    // The combined message is deliberate: the guard was ONE `if (!a || !b)`, so a caller
    // missing only projectId has always been told about both.
    ["analyze-dependencies names both fields", "/api/issues/analyze-dependencies", { issueId: "x" }, "issueId and projectId are required"],
    ["ai-estimate rejects a missing issueId", "/api/issues/ai-estimate", {}, "issueId is required"],
    ["contract rejects a missing projectId", "/api/issues/contract", {}, "projectId is required"],
    ["contract/confirm rejects a missing survivorId", "/api/issues/contract/confirm", { projectId: "p" }, "survivorId is required"],
    ["contract/confirm rejects a short memberIds", "/api/issues/contract/confirm", { projectId: "p", survivorId: "s", memberIds: ["only-one"] }, "memberIds must be an array of at least 2 ids"],
    ["contract/confirm rejects a blank mergedTitle", "/api/issues/contract/confirm", { projectId: "p", survivorId: "s", memberIds: ["a", "b"], mergedTitle: "  " }, "mergedTitle is required"],
    ["batch rejects a non-array issues", "/api/issues/batch", { projectId: "p", issues: "nope" }, "issues must be an array"],
    ["batch rejects a non-array dependencies", "/api/issues/batch", { projectId: "p", issues: [], dependencies: "nope" }, "dependencies must be an array"],
    ["dependencies/batch rejects a non-array edges", "/api/issues/dependencies/batch", {}, "edges must be an array"],
    ["contract-coupled rejects an empty issueIds", "/api/issues/contract-coupled", { issueIds: [] }, "issueIds must be a non-empty array"],
    ["bulk rejects an empty issueIds", "/api/issues/bulk", { issueIds: [] }, "issueIds must be a non-empty array", "PATCH"],
    ["bulk rejects a missing updates", "/api/issues/bulk", { issueIds: ["a"] }, "updates is required", "PATCH"],
  ];

  for (const [name, path, body, message, method] of cases) {
    it(name, async () => {
      const res = await post(path, body, method);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(message);
    });
  }

  it("reports the FIRST failure only, in the old guard's order", async () => {
    // projectId and survivorId are both missing; the guard ladder checked projectId
    // first, so zod's schema must declare it first too. Field order in the schema IS the
    // contract here, which is easy to lose in a later edit.
    const res = await post("/api/issues/contract/confirm", {});
    expect(res.body.error).toBe("projectId is required");
  });

  it("still rejects a malformed JSON body with the unchanged message", async () => {
    const res = await app.request("/api/issues/enhance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe("invalid JSON body");
  });

  it("accepts a valid body (the schema does not reject what the guards allowed)", async () => {
    // A non-vacuity check: every assertion above is about REJECTION, so without this a
    // schema that rejected everything would pass the whole suite.
    const res = await post("/api/issues/batch", { projectId, issues: [] });
    expect(res.status).toBe(201);
  });
});
