import { test, expect, chromium } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Copy issue reference to clipboard", () => {
  let projectId: string;
  let statusId: string;
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const activePrefRes = await request.get(
      `${SERVER_URL}/api/preferences/active-project`,
    );
    const { projectId: activeId } = await activePrefRes.json();
    projectId = activeId;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find(
      (s: { name: string }) => s.name === "Todo",
    );
    statusId = todoStatus ? todoStatus.id : statuses[0].id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  test("clicking copy button shows checkmark and copies issue reference to clipboard", async ({
    page,
    context,
    request,
  }) => {
    const suffix = Date.now().toString(36);
    const title = `CopyRefTest ${suffix}`;

    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title, priority: "low", statusId, projectId },
    });
    const issue = await createRes.json();
    createdIssueIds.push(issue.id);
    const issueNumber = issue.issueNumber as number;

    // Grant clipboard permissions so navigator.clipboard.readText() works
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    await page.goto("/");
    await page.waitForSelector("[data-testid='board-stats-bar']", {
      timeout: 10000,
    });

    // Open issue detail panel
    const card = page.locator("p", { hasText: title }).first();
    await expect(card).toBeVisible({ timeout: 10000 });
    await card.click({ force: true });
    await expect(
      page.locator("h2", { hasText: "Issue Details" }),
    ).toBeVisible({ timeout: 5000 });

    // The copy button title is "Copy issue reference"
    const copyButton = page.locator('button[title="Copy issue reference"]');
    await expect(copyButton).toBeVisible({ timeout: 5000 });

    await copyButton.click();

    // After clicking, button should show "Copied!" title (checkmark state)
    await expect(page.locator('button[title="Copied!"]')).toBeVisible({
      timeout: 3000,
    });

    // Verify clipboard content matches expected issue reference format: "#N title"
    const clipboardText = await page.evaluate(() =>
      navigator.clipboard.readText(),
    );
    expect(clipboardText).toBe(`#${issueNumber} ${title}`);
  });
});
