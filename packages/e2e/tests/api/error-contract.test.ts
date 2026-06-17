import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

// Shared error-response contract: every error path returns a JSON body with a STRING `error` field.
// Verified against real source:
//   - GET /api/issues/:id         (issues.ts ~631)  -> { error: "Issue not found" } 404
//   - GET /api/workspaces/:id     (workspaces.ts ~347) -> { error: "Workspace not found" } 404
//   - GET /api/sessions/:id/output (sessions.ts)  -> { error: "Session not found" } 404
//   - POST /api/issues (no title) (issues.ts ~60)  -> { error: "title is required" } 400
// NOTE: there is intentionally no `GET /api/projects/:id` route, so a bogus project id hits
// Hono's plain-text 404 (not the JSON contract) — that's why a session 404 is used here instead.
//   - POST /api/issues/:id/artifacts (no content)  -> { error: "type and content are required" } 400
// The global domainErrorHandler (middleware/error-handler.ts) and all inline returns use the SAME
// `{ error: string }` shape — there is no `{ message }` variant on these representative routes.

test.describe("Error response contract ({ error: string })", () => {
  let projectId: string;
  let statusId: string;
  let suffix: string;
  const createdIssueIds: string[] = [];

  async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    throw new Error(`[${label}] failed after 3 attempts: ${String(lastErr)}`);
  }

  test.beforeAll(async ({ request }) => {
    projectId = await withRetry(() => getE2EProjectId(request), "getE2EProjectId");
    const statuses = await withRetry(async () => {
      const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
      if (!res.ok()) throw new Error(`statuses ${res.status()}`);
      return res.json();
    }, "fetch statuses");
    const todo = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todo ? todo.id : statuses[0].id;
    suffix = Date.now().toString(36);
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  function expectErrorBody(body: unknown): asserts body is { error: string } {
    expect(body).not.toBeNull();
    expect(typeof body).toBe("object");
    expect(typeof (body as { error?: unknown }).error).toBe("string");
    expect((body as { error: string }).error.length).toBeGreaterThan(0);
  }

  test("GET non-existent issue -> 404 { error }", async ({ request }) => {
    const res = await request.get(`${SERVER_URL}/api/issues/does-not-exist-${suffix}`);
    expect(res.status()).toBe(404);
    const body = await res.json();
    expectErrorBody(body);
    expect(body.error).toBe("Issue not found");
  });

  test("GET non-existent workspace -> 404 { error }", async ({ request }) => {
    const res = await request.get(`${SERVER_URL}/api/workspaces/does-not-exist-${suffix}`);
    expect(res.status()).toBe(404);
    const body = await res.json();
    expectErrorBody(body);
    expect(body.error).toBe("Workspace not found");
  });

  test("GET non-existent session output -> 404 { error }", async ({ request }) => {
    const res = await request.get(`${SERVER_URL}/api/sessions/does-not-exist-${suffix}/output`);
    expect(res.status()).toBe(404);
    const body = await res.json();
    expectErrorBody(body);
    expect(body.error).toBe("Session not found");
  });

  test("POST issue with a missing required field (title) -> 400 { error }", async ({
    request,
  }) => {
    const res = await request.post(`${SERVER_URL}/api/issues`, {
      data: { statusId, projectId }, // no title
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expectErrorBody(body);
    expect(body.error).toBe("title is required");
  });

  test("POST artifact with a missing required field (content) -> 400 { error }", async ({
    request,
  }) => {
    // Need a real issue so we exercise the artifact validation path, not a 404.
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `Error contract ${suffix}`, statusId, projectId },
    });
    expect(issueRes.status()).toBe(201);
    const issueId = (await issueRes.json()).id;
    createdIssueIds.push(issueId);

    const res = await request.post(`${SERVER_URL}/api/issues/${issueId}/artifacts`, {
      data: { type: "link" }, // content missing
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expectErrorBody(body);
    expect(body.error).toBe("type and content are required");
  });
});
