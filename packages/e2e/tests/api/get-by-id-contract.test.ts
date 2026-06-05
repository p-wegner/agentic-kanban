/**
 * Contract tests: GET-by-id endpoints must return the same canonical field set
 * as their corresponding list endpoints. Guards against partial projections that
 * accidentally expose only a subset of columns (e.g. the AK-559 bug where
 * GET /api/issues/:id returned only {id, description}).
 *
 * Strategy: create a resource, fetch it via both the list and the get-by-id
 * endpoint, then assert that every key present in the list item is also present
 * in the get-by-id response.
 */
import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

// Helper: assert every key in `listItem` is present in `byIdItem`.
function assertContainsListFields(
  byIdItem: Record<string, unknown>,
  listItem: Record<string, unknown>,
  label: string,
) {
  for (const key of Object.keys(listItem)) {
    expect(
      key in byIdItem,
      `${label}: key "${key}" present in list response but missing in GET-by-id response`,
    ).toBe(true);
  }
}

test.describe("Contract: GET-by-id returns canonical field set (issues)", () => {
  let projectId: string;
  let statusId: string;
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    projectId = await getE2EProjectId(request);
    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    statusId = statuses[0].id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`).catch(() => {});
    }
  });

  test("GET /api/issues/:id returns all fields present in the list response", async ({
    request,
  }) => {
    const suffix = Date.now().toString(36);
    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `Contract test issue ${suffix}`,
        description: "Contract test description",
        priority: "medium",
        statusId,
        projectId,
      },
    });
    expect(createRes.status()).toBe(201);
    const created = await createRes.json();
    createdIssueIds.push(created.id);

    // Fetch via list endpoint
    const listRes = await request.get(
      `${SERVER_URL}/api/issues?projectId=${projectId}`,
    );
    expect(listRes.ok()).toBeTruthy();
    const list = await listRes.json();
    const listItem = list.find((i: { id: string }) => i.id === created.id);
    expect(listItem).toBeDefined();

    // Fetch via GET-by-id
    const byIdRes = await request.get(`${SERVER_URL}/api/issues/${created.id}`);
    expect(byIdRes.ok()).toBeTruthy();
    const byIdItem = await byIdRes.json();

    assertContainsListFields(byIdItem, listItem, "GET /api/issues/:id");
  });
});

test.describe("Contract: GET-by-id returns canonical field set (workspaces)", () => {
  let projectId: string;
  let statusId: string;
  let issueId: string;
  const suffix = Date.now().toString(36);
  const createdWorkspaceIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    projectId = await getE2EProjectId(request);
    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todoStatus ? todoStatus.id : statuses[0].id;

    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `Workspace contract test ${suffix}`,
        statusId,
        projectId,
      },
    });
    issueId = (await issueRes.json()).id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`).catch(() => {});
    }
    if (issueId) {
      await request.delete(`${SERVER_URL}/api/issues/${issueId}`).catch(() => {});
    }
  });

  test("GET /api/workspaces/:id returns all fields present in the issue workspaces list response", async ({
    request,
  }) => {
    const createRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        issueId,
        branch: `feature/contract-test-${suffix}`,
      },
    });
    expect(createRes.status()).toBe(201);
    const created = await createRes.json();
    createdWorkspaceIds.push(created.id);

    // Fetch via list endpoint (GET /api/issues/:id/workspaces)
    const listRes = await request.get(
      `${SERVER_URL}/api/issues/${issueId}/workspaces`,
    );
    expect(listRes.ok()).toBeTruthy();
    const list = await listRes.json();
    const listItem = list.find((w: { id: string }) => w.id === created.id);
    expect(listItem).toBeDefined();

    // Fetch via GET-by-id
    const byIdRes = await request.get(
      `${SERVER_URL}/api/workspaces/${created.id}`,
    );
    expect(byIdRes.ok()).toBeTruthy();
    const byIdItem = await byIdRes.json();

    assertContainsListFields(byIdItem, listItem, "GET /api/workspaces/:id");
  });
});

test.describe("Contract: GET-by-id returns canonical field set (agent-skills)", () => {
  const createdIds: string[] = [];
  const suffix = Date.now().toString(36);

  test.afterAll(async ({ request }) => {
    for (const id of createdIds) {
      await request.delete(`${SERVER_URL}/api/agent-skills/${id}`).catch(() => {});
    }
  });

  test("GET /api/agent-skills/:id returns all fields present in the list response", async ({
    request,
  }) => {
    const createRes = await request.post(`${SERVER_URL}/api/agent-skills`, {
      data: {
        name: `contract-skill-${suffix}`,
        description: "Contract test skill",
        prompt: "Contract test prompt",
      },
    });
    expect(createRes.status()).toBe(201);
    const created = await createRes.json();
    createdIds.push(created.id);

    // Fetch via list endpoint
    const listRes = await request.get(`${SERVER_URL}/api/agent-skills`);
    expect(listRes.ok()).toBeTruthy();
    const list = await listRes.json();
    const listItem = list.find((s: { id: string }) => s.id === created.id);
    expect(listItem).toBeDefined();

    // Fetch via GET-by-id
    const byIdRes = await request.get(
      `${SERVER_URL}/api/agent-skills/${created.id}`,
    );
    expect(byIdRes.ok()).toBeTruthy();
    const byIdItem = await byIdRes.json();

    assertContainsListFields(byIdItem, listItem, "GET /api/agent-skills/:id");
  });
});
