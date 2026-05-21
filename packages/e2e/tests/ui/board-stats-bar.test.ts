import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Board stats bar", () => {
  let projectId: string;
  let todoStatusId: string;
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    // Use the active project (set by global-setup to the E2E Test Project)
    const activeRes = await request.get(`${SERVER_URL}/api/preferences/active-project`);
    const { projectId: activeId } = await activeRes.json();
    projectId = activeId;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    todoStatusId = todoStatus ? todoStatus.id : statuses[0].id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  test("shows ticket counts per status in stats bar", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const titles = [
      `StatsTest A ${suffix}`,
      `StatsTest B ${suffix}`,
      `StatsTest C ${suffix}`,
    ];

    for (const title of titles) {
      const res = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title, statusId: todoStatusId, projectId },
      });
      const { id } = await res.json();
      createdIssueIds.push(id);
    }

    await page.goto("/");

    // Fetch actual board counts to assert accurately
    const boardRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/board`);
    const board = await boardRes.json();
    const todoCol = board.find((c: { name: string }) => c.name === "Todo");
    const todoCount = todoCol?.issues?.length ?? 0;

    // Wait for the stats bar to appear (board loads async after skeleton)
    const statsBar = page.locator("[data-testid='board-stats-bar']");
    await expect(statsBar).toBeVisible({ timeout: 10000 });

    // The stats bar lists each active column name followed by its count
    // We check the Todo column count text matches what the board API returns
    const todoPart = statsBar.locator("div.flex.items-center.gap-1", {
      hasText: "Todo",
    }).first();
    await expect(todoPart).toBeVisible();
    const countSpan = todoPart.locator("span").last();
    await expect(countSpan).toHaveText(String(todoCount));
  });

  test("shows commits counter in stats bar", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("[data-testid='board-stats-bar']", { timeout: 10000 });

    // The commits counter renders as "N commits" text — wait for it (async fetch)
    const commitsText = page.locator("text=/\\d+ commits/");
    await expect(commitsText).toBeVisible({ timeout: 10000 });
  });

  test("Blocked filter shows only blocked issues, toggle off restores all", async ({
    page,
    request,
  }) => {
    const suffix = Date.now().toString(36);
    const blockerTitle = `Blocker ${suffix}`;
    const blockedTitle = `Blocked ${suffix}`;
    const normalTitle = `Normal ${suffix}`;

    // Create blocker issue (stays in Todo — so it remains unresolved)
    const blockerRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: blockerTitle, statusId: todoStatusId, projectId },
    });
    const { id: blockerId } = await blockerRes.json();
    createdIssueIds.push(blockerId);

    // Create issue that depends on the blocker (will be blocked)
    const blockedRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: blockedTitle, statusId: todoStatusId, projectId },
    });
    const { id: blockedId } = await blockedRes.json();
    createdIssueIds.push(blockedId);

    // Create unblocked normal issue
    const normalRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: normalTitle, statusId: todoStatusId, projectId },
    });
    const { id: normalId } = await normalRes.json();
    createdIssueIds.push(normalId);

    // Add dependency: blockedId depends_on blockerId
    await request.post(`${SERVER_URL}/api/issues/${blockedId}/dependencies`, {
      data: { dependsOnId: blockerId, type: "depends_on" },
    });

    await page.goto("/");

    // Wait for board to fully load (past the skeleton phase)
    await page.waitForSelector("[data-testid='board-stats-bar']", { timeout: 10000 });

    // All three issues should be visible before filter
    await expect(page.locator("p", { hasText: blockerTitle }).first()).toBeVisible();
    await expect(page.locator("p", { hasText: blockedTitle }).first()).toBeVisible();
    await expect(page.locator("p", { hasText: normalTitle }).first()).toBeVisible();

    // Click the Blocked filter button in the stats bar
    const blockedToggle = page.locator("button", { hasText: /^Blocked$/ });
    await expect(blockedToggle).toBeVisible();
    await blockedToggle.click();

    // After filter: only the blocked issue should be visible
    await expect(page.locator("p", { hasText: blockedTitle }).first()).toBeVisible();
    await expect(page.locator("p", { hasText: blockerTitle })).not.toBeVisible();
    await expect(page.locator("p", { hasText: normalTitle })).not.toBeVisible();

    // Toggle Blocked filter off
    await blockedToggle.click();

    // All issues reappear
    await expect(page.locator("p", { hasText: blockerTitle }).first()).toBeVisible();
    await expect(page.locator("p", { hasText: blockedTitle }).first()).toBeVisible();
    await expect(page.locator("p", { hasText: normalTitle }).first()).toBeVisible();
  });
});
