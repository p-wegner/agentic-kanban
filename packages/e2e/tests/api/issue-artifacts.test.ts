import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

// #205 — issue artifacts CRUD. Routes in packages/server/src/routes/issues.ts (~730-755):
//   GET    /api/issues/:id/artifacts        -> bare array of issue_artifacts rows
//   POST   /api/issues/:id/artifacts        -> { id } (201); body { type, content, mimeType?, caption?, workspaceId? }
//   DELETE /api/issues/:id/artifacts/:artId -> { success: true }
// Service: issueService.addArtifact validates type ∈ {image,text,link,video}; getArtifacts = select * from issue_artifacts.
// Row columns (packages/shared/src/schema/issue-artifacts.ts): id, issueId, workspaceId, type, mimeType, content, caption, createdAt.

test.describe("Issue artifacts CRUD API", () => {
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

  async function createIssue(request: any, label: string): Promise<string> {
    return withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title: `Artifacts ${label} ${suffix}`, statusId, projectId },
      });
      if (res.status() !== 201) throw new Error(`create issue ${res.status()}`);
      const id = (await res.json()).id;
      createdIssueIds.push(id);
      return id;
    }, `create issue ${label}`);
  }

  test("create -> list -> delete -> list round-trips a text artifact", async ({ request }) => {
    const issueId = await createIssue(request, "crud");

    // Initially no artifacts — bare array, empty.
    const before = await request.get(`${SERVER_URL}/api/issues/${issueId}/artifacts`);
    expect(before.status()).toBe(200);
    const beforeBody = await before.json();
    expect(Array.isArray(beforeBody)).toBe(true);
    expect(beforeBody.length).toBe(0);

    // Create a link artifact (avoids the text-type worktree-materialization side effect).
    const caption = `cap-${suffix}`;
    const content = `https://example.com/${suffix}`;
    const createRes = await request.post(`${SERVER_URL}/api/issues/${issueId}/artifacts`, {
      data: { type: "link", content, caption },
    });
    expect(createRes.status()).toBe(201);
    const created = await createRes.json();
    // POST returns only { id }.
    expect(typeof created.id).toBe("string");
    const artifactId: string = created.id;

    // GET now lists it with the real row columns.
    const after = await request.get(`${SERVER_URL}/api/issues/${issueId}/artifacts`);
    expect(after.status()).toBe(200);
    const list = await after.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(1);
    const row = list[0];
    expect(row.id).toBe(artifactId);
    expect(row.issueId).toBe(issueId);
    expect(row.type).toBe("link");
    expect(row.content).toBe(content);
    expect(row.caption).toBe(caption);
    expect(row.workspaceId).toBeNull();
    expect(typeof row.createdAt).toBe("string");

    // DELETE returns { success: true }.
    const delRes = await request.delete(
      `${SERVER_URL}/api/issues/${issueId}/artifacts/${artifactId}`,
    );
    expect(delRes.status()).toBe(200);
    expect(await delRes.json()).toEqual({ success: true });

    // GET confirms it's gone.
    const gone = await request.get(`${SERVER_URL}/api/issues/${issueId}/artifacts`);
    expect(gone.status()).toBe(200);
    const goneBody = await gone.json();
    expect(Array.isArray(goneBody)).toBe(true);
    expect(goneBody.length).toBe(0);
  });

  test("POST with a missing required field returns 400 { error }", async ({ request }) => {
    const issueId = await createIssue(request, "missing-field");
    // Handler: `if (!body.type || !body.content) return c.json({ error: "type and content are required" }, 400)`.
    const res = await request.post(`${SERVER_URL}/api/issues/${issueId}/artifacts`, {
      data: { type: "link" }, // content missing
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(body.error).toBe("type and content are required");
  });

  test("POST with an invalid artifact type returns 400 { error }", async ({ request }) => {
    const issueId = await createIssue(request, "bad-type");
    // addArtifact throws IssueError BAD_REQUEST for a type outside {image,text,link,video};
    // createRouter().onError(domainErrorHandler) maps BAD_REQUEST -> 400 { error }.
    const res = await request.post(`${SERVER_URL}/api/issues/${issueId}/artifacts`, {
      data: { type: "bogus", content: "x" },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain("type must be one of");
  });
});
