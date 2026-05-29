import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

test.describe("Showdown API", () => {
  let projectId: string;
  let statusId: string;
  let issueId: string;
  const createdWorkspaceIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    projectId = await getE2EProjectId(request);

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    statusId = statuses[0].id;

    // Create a trivial fixture issue
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `Showdown test issue ${Date.now()}`,
        description: "Fixture issue for showdown tests",
        priority: "low",
        statusId,
        projectId,
      },
    });
    expect(issueRes.status()).toBe(201);
    const issue = await issueRes.json();
    issueId = issue.id;
  });

  test.afterAll(async ({ request }) => {
    // Delete created workspaces (cascade-deletes sessions)
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`).catch(() => {});
    }
    // Delete the fixture issue
    if (issueId) {
      await request.delete(`${SERVER_URL}/api/issues/${issueId}`).catch(() => {});
    }
  });

  test("POST /api/issues/:id/showdown creates a showdown with N workspaces", async ({ request }) => {
    const res = await request.post(`${SERVER_URL}/api/issues/${issueId}/showdown`, {
      data: {
        contestants: [
          { model: "" },
          { model: "" },
        ],
      },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.issueId).toBe(issueId);
    expect(body.status).toBe("active");
    expect(Array.isArray(body.contestants)).toBe(true);
    expect(body.contestants).toHaveLength(2);

    // Each contestant has a workspace
    for (const c of body.contestants) {
      expect(c.workspaceId).toBeDefined();
      expect(c.label).toMatch(/^[A-D]$/);
      createdWorkspaceIds.push(c.workspaceId);
    }

    // Labels should be A and B
    const labels = body.contestants.map((c: { label: string }) => c.label);
    expect(labels).toContain("A");
    expect(labels).toContain("B");
  });

  test("GET /api/issues/:id/showdown returns the active showdown", async ({ request }) => {
    // First, create a showdown
    const createRes = await request.post(`${SERVER_URL}/api/issues/${issueId}/showdown`, {
      data: {
        contestants: [{ model: "" }, { model: "" }],
      },
    });
    if (!createRes.ok()) {
      // May already have one — that's fine, test GET regardless
    } else {
      const created = await createRes.json();
      for (const c of created.contestants) {
        createdWorkspaceIds.push(c.workspaceId);
      }
    }

    const res = await request.get(`${SERVER_URL}/api/issues/${issueId}/showdown`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.issueId).toBe(issueId);
    expect(Array.isArray(body.contestants)).toBe(true);
  });

  test("GET /api/showdowns/:id returns showdown details", async ({ request }) => {
    // Create a showdown first
    const createRes = await request.post(`${SERVER_URL}/api/issues/${issueId}/showdown`, {
      data: {
        contestants: [{ model: "" }, { model: "" }],
      },
    });
    if (!createRes.ok()) {
      // Get the existing one
      const existingRes = await request.get(`${SERVER_URL}/api/issues/${issueId}/showdown`);
      if (!existingRes.ok()) {
        test.skip();
        return;
      }
      const existing = await existingRes.json();
      const res = await request.get(`${SERVER_URL}/api/showdowns/${existing.id}`);
      expect(res.ok()).toBeTruthy();
      const body = await res.json();
      expect(body.id).toBe(existing.id);
    } else {
      const created = await createRes.json();
      for (const c of created.contestants) {
        createdWorkspaceIds.push(c.workspaceId);
      }
      const res = await request.get(`${SERVER_URL}/api/showdowns/${created.id}`);
      expect(res.ok()).toBeTruthy();
      const body = await res.json();
      expect(body.id).toBe(created.id);
      expect(body.contestants).toHaveLength(created.contestants.length);
    }
  });

  test("POST /api/showdowns/:id/pick-winner sets status to decided and removes losers", async ({ request }) => {
    // Create a fresh showdown for this test
    const createRes = await request.post(`${SERVER_URL}/api/issues/${issueId}/showdown`, {
      data: {
        contestants: [{ model: "" }, { model: "" }],
      },
    });
    // It's possible creating another showdown when one already exists may fail or succeed
    // depending on implementation — either way we just try to pick a winner
    let showdownId: string;
    let winnerWorkspaceId: string;
    let loserWorkspaceId: string;

    if (createRes.ok()) {
      const sd = await createRes.json();
      showdownId = sd.id;
      winnerWorkspaceId = sd.contestants[0].workspaceId;
      loserWorkspaceId = sd.contestants[1].workspaceId;
    } else {
      const existingRes = await request.get(`${SERVER_URL}/api/issues/${issueId}/showdown`);
      if (!existingRes.ok()) {
        test.skip();
        return;
      }
      const existing = await existingRes.json();
      showdownId = existing.id;
      winnerWorkspaceId = existing.contestants[0].workspaceId;
      loserWorkspaceId = existing.contestants[1].workspaceId;
    }

    // Pick the winner
    const pickRes = await request.post(`${SERVER_URL}/api/showdowns/${showdownId}/pick-winner`, {
      data: { winnerWorkspaceId },
    });
    expect(pickRes.ok()).toBeTruthy();
    const result = await pickRes.json();
    expect(result.status).toBe("decided");
    expect(result.winnerWorkspaceId).toBe(winnerWorkspaceId);

    // Loser workspace should be deleted (404)
    const loserRes = await request.get(`${SERVER_URL}/api/workspaces/${loserWorkspaceId}`);
    expect(loserRes.status()).toBe(404);

    // Winner workspace should still exist
    const winnerRes = await request.get(`${SERVER_URL}/api/workspaces/${winnerWorkspaceId}`);
    expect(winnerRes.ok()).toBeTruthy();
    createdWorkspaceIds.push(winnerWorkspaceId);
  });
});
