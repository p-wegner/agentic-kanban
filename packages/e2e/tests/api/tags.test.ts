import { test, expect } from "@playwright/test";
import { SERVER_URL as BASE } from "../helpers/port.js";

test.describe("Tags API", () => {
  let projectId: string;
  let statusId: string;
  let createdTagId: string;
  let createdIssueId: string;

  test.beforeAll(async ({ request }) => {
    // Get the default project
    const projectsRes = await request.get(`${BASE}/api/projects`);
    const projects = await projectsRes.json();
    projectId = projects[0].id;

    // Get statuses for the project
    const statusesRes = await request.get(
      `${BASE}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find(
      (s: { name: string }) => s.name === "Todo",
    );
    statusId = todoStatus ? todoStatus.id : statuses[0].id;
  });

  test("GET /api/tags returns seed tags", async ({ request }) => {
    const res = await request.get(`${BASE}/api/tags`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    // After seed, there should be 4 default tags
    expect(body.length).toBeGreaterThanOrEqual(4);
    const names = body.map((t: { name: string }) => t.name);
    expect(names).toContain("bug");
    expect(names).toContain("feature");
    expect(names).toContain("improvement");
    expect(names).toContain("docs");
  });

  test("POST /api/tags creates a tag", async ({ request }) => {
    const tagName = `test-tag-${Date.now()}`;
    const res = await request.post(`${BASE}/api/tags`, {
      data: { name: tagName, color: "#FF0000" },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBe(tagName);
    expect(body.color).toBe("#FF0000");
    createdTagId = body.id;
  });

  test("POST /api/tags rejects missing name", async ({ request }) => {
    const res = await request.post(`${BASE}/api/tags`, {
      data: { color: "#FF0000" },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("name");
  });

  test("GET /api/tags includes newly created tag", async ({ request }) => {
    const res = await request.get(`${BASE}/api/tags`);
    const body = await res.json();
    expect(
      body.some((t: { id: string }) => t.id === createdTagId),
    ).toBeTruthy();
  });

  test("PATCH /api/tags/:id updates tag name and color", async ({
    request,
  }) => {
    const newName = `updated-tag-${Date.now()}`;
    const res = await request.patch(`${BASE}/api/tags/${createdTagId}`, {
      data: { name: newName, color: "#00FF00" },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.id).toBe(createdTagId);

    // Verify the update by listing tags
    const listRes = await request.get(`${BASE}/api/tags`);
    const list = await listRes.json();
    const updated = list.find((t: { id: string }) => t.id === createdTagId);
    expect(updated).toBeDefined();
    expect(updated.name).toBe(newName);
    expect(updated.color).toBe("#00FF00");
  });

  test("PATCH /api/tags/:id rejects empty update", async ({ request }) => {
    const res = await request.patch(`${BASE}/api/tags/${createdTagId}`, {
      data: {},
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("No fields to update");
  });

  test("POST /api/issues/:id/tags assigns tag to issue", async ({
    request,
  }) => {
    // Create an issue first
    const issueRes = await request.post(`${BASE}/api/issues`, {
      data: {
        title: "Tag test issue",
        statusId,
        projectId,
      },
    });
    expect(issueRes.status()).toBe(201);
    const issueBody = await issueRes.json();
    createdIssueId = issueBody.id;

    // Assign tag to issue
    const assignRes = await request.post(
      `${BASE}/api/issues/${createdIssueId}/tags`,
      {
        data: { tagId: createdTagId },
      },
    );
    expect(assignRes.status()).toBe(201);
    const assignBody = await assignRes.json();
    expect(assignBody.id).toBeDefined();
  });

  test("POST /api/issues/:id/tags rejects missing tagId", async ({
    request,
  }) => {
    const res = await request.post(
      `${BASE}/api/issues/${createdIssueId}/tags`,
      {
        data: {},
      },
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("tagId");
  });

  test("GET /api/issues/:id/tags returns assigned tags", async ({
    request,
  }) => {
    const res = await request.get(
      `${BASE}/api/issues/${createdIssueId}/tags`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
    const assigned = body.find(
      (t: { id: string }) => t.id === createdTagId,
    );
    expect(assigned).toBeDefined();
    // Tag should have id, name, color
    expect(assigned.name).toBeDefined();
    expect(assigned.color).toBeDefined();
  });

  test("DELETE /api/issues/:id/tags/:tagId removes tag from issue", async ({
    request,
  }) => {
    const res = await request.delete(
      `${BASE}/api/issues/${createdIssueId}/tags/${createdTagId}`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);

    // Verify tag is removed
    const getRes = await request.get(
      `${BASE}/api/issues/${createdIssueId}/tags`,
    );
    const tags = await getRes.json();
    expect(
      tags.some((t: { id: string }) => t.id === createdTagId),
    ).toBeFalsy();
  });

  test("DELETE /api/tags/:id deletes tag", async ({ request }) => {
    const res = await request.delete(`${BASE}/api/tags/${createdTagId}`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);

    // Verify tag is gone from list
    const listRes = await request.get(`${BASE}/api/tags`);
    const list = await listRes.json();
    expect(
      list.some((t: { id: string }) => t.id === createdTagId),
    ).toBeFalsy();
  });
});
