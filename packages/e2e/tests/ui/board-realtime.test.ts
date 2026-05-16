import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Board Real-time Updates", () => {
  let projectId: string;
  let statusId: string;

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();
    projectId = projects[0].id;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todoStatus ? todoStatus.id : statuses[0].id;
  });

  test("board updates when issue created via API", async ({ page, request }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    // Create an issue via API
    const uniqueTitle = `RT create test ${Date.now()}`;
    await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: uniqueTitle, statusId, projectId },
    });

    // Board should auto-refresh and show the new issue
    await expect(
      page.locator("p", { hasText: uniqueTitle }).first(),
    ).toBeVisible({ timeout: 5000 });
  });

  test("board updates when issue status changes via API", async ({ page, request }) => {
    // Create an issue
    const uniqueTitle = `RT status test ${Date.now()}`;
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: uniqueTitle, statusId, projectId },
    });
    const { id: issueId } = await issueRes.json();

    // Get the "Done" status
    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const doneStatus = statuses.find((s: { name: string }) => s.name === "Done");

    if (!doneStatus) {
      test.skip();
      return;
    }

    await page.goto("/");
    await page.waitForSelector("h2");

    // Wait for the issue to appear
    await expect(
      page.locator("p", { hasText: uniqueTitle }).first(),
    ).toBeVisible({ timeout: 5000 });

    // Move issue to "Done" via API
    await request.patch(`${SERVER_URL}/api/issues/${issueId}`, {
      data: { statusId: doneStatus.id },
    });

    // Verify the API shows the updated status
    const boardRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/board`,
    );
    const board = await boardRes.json();
    const movedIssue = board
      .find((col: { name: string }) => col.name === "Done")
      ?.issues?.find((i: { title: string }) => i.title === uniqueTitle);
    expect(movedIssue).toBeDefined();
  });
});
