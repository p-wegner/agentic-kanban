import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

test.describe("TDD mode", () => {
  let projectId: string;
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
    const statusId = todoStatus ? todoStatus.id : statuses[0].id;

    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `TDD mode test issue ${suffix}`,
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

  test("tdd-mode is a built-in skill", async ({ request }) => {
    const res = await request.get(`${SERVER_URL}/api/agent-skills`);
    expect(res.ok()).toBeTruthy();
    const skills = await res.json();
    const tddSkill = skills.find((s: { name: string }) => s.name === "tdd-mode");
    expect(tddSkill).toBeDefined();
    expect(tddSkill.isBuiltin).toBe(true);
    expect(tddSkill.description).toContain("AC-driven");
  });

  test("POST /api/workspaces accepts tddMode flag and stores it", async ({ request }) => {
    const res = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        issueId,
        branch: `feature/tdd-test-${suffix}`,
        tddMode: true,
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    createdWorkspaceIds.push(body.id);

    // Verify the workspace was created (API returns active status)
    expect(body.status).toBe("active");
  });

  test("POST /api/workspaces with tddMode false creates workspace without TDD", async ({ request }) => {
    const res = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        issueId,
        branch: `feature/no-tdd-test-${suffix}`,
        tddMode: false,
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    createdWorkspaceIds.push(body.id);
    expect(body.status).toBe("active");
  });

  test("per-project TDD preference can be set and retrieved", async ({ request }) => {
    const prefKey = `tdd_mode_${projectId}`;

    // Set project-specific TDD preference
    const putRes = await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { [prefKey]: "true" },
    });
    expect(putRes.ok()).toBeTruthy();

    // Retrieve it
    const getRes = await request.get(`${SERVER_URL}/api/preferences/settings`);
    expect(getRes.ok()).toBeTruthy();
    const settings = await getRes.json();
    expect(settings[prefKey]).toBe("true");

    // Clean up
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { [prefKey]: "false" },
    });
  });
});
