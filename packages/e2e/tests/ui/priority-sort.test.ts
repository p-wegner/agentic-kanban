import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

/**
 * Issue type sort order: bug(0) > feature(1) > task(2) > chore(3)
 * Toggle button text: "↑T"
 * localStorage key: col-sort-<columnId>
 */

test.describe("Type-based column sort", () => {
  let projectId: string;
  let todoStatusId: string;
  let inProgressStatusId: string;
  let inReviewStatusId: string;
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const prefRes = await request.get(`${SERVER_URL}/api/preferences/active-project`);
    const pref = await prefRes.json();
    projectId = pref.projectId;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();

    const find = (name: string) =>
      statuses.find((s: { name: string }) => s.name === name)?.id;

    todoStatusId = find("Todo") ?? statuses[0].id;
    inProgressStatusId = find("In Progress") ?? statuses[1]?.id;
    inReviewStatusId = find("In Review") ?? statuses[2]?.id;

    // Create four issues in Todo with different types
    const issueTypes: Array<{ title: string; issueType: string }> = [
      { title: `Sort-Chore-${Date.now()}`, issueType: "chore" },
      { title: `Sort-Task-${Date.now() + 1}`, issueType: "task" },
      { title: `Sort-Feature-${Date.now() + 2}`, issueType: "feature" },
      { title: `Sort-Bug-${Date.now() + 3}`, issueType: "bug" },
    ];

    for (const { title, issueType } of issueTypes) {
      const res = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title, issueType, statusId: todoStatusId, projectId },
      });
      const issue = await res.json();
      createdIssueIds.push(issue.id);
    }

    // Make our test project the active project so the board displays our issues
    await request.put(`${SERVER_URL}/api/preferences/active-project`, {
      data: { projectId },
    });
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  async function findTodoColumn(page: import("@playwright/test").Page) {
    await page.waitForSelector("h2");
    const columns = page.locator(".bg-gray-100.rounded-xl");
    const count = await columns.count();
    for (let i = 0; i < count; i++) {
      const col = columns.nth(i);
      const heading = await col.locator("h2").textContent();
      if (heading?.replace(/\s*\d+$/, "").trim() === "Todo") {
        return col;
      }
    }
    throw new Error("Todo column not found");
  }

  test("sort button toggles active state", async ({ page }) => {
    // Clear any persisted sort state so test is deterministic
    await page.goto("/");
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("col-sort-")) localStorage.removeItem(key);
      }
    });

    const todoCol = await findTodoColumn(page);
    const sortBtn = todoCol.locator('button[title="Sort by type"]');

    // Button should be in inactive state initially
    await expect(sortBtn).toBeVisible();
    await expect(sortBtn).not.toHaveClass(/bg-blue-100/);

    await sortBtn.click();

    // After clicking, button becomes active (blue highlight)
    const activeBtn = todoCol.locator(
      'button[title="Sorted by type — click for default"]',
    );
    await expect(activeBtn).toBeVisible();
    await expect(activeBtn).toHaveClass(/bg-blue-100/);
  });

  test("bug issues appear before feature, task, chore in Todo", async ({
    page,
  }) => {
    await page.goto("/");
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("col-sort-")) localStorage.removeItem(key);
      }
    });

    const todoCol = await findTodoColumn(page);

    // Activate type sort
    const sortBtn = todoCol.locator('button[title="Sort by type"]');
    await sortBtn.click();
    await expect(
      todoCol.locator('button[title="Sorted by type — click for default"]'),
    ).toBeVisible();

    // Collect visible issue titles in order.
    // Each IssueCard has a bg-white rounded-md card; first <p> inside is the title.
    const cards = todoCol.locator(".bg-white.rounded-md");
    const cardCount = await cards.count();
    const ourTitles: string[] = [];
    for (let i = 0; i < cardCount; i++) {
      const titleEl = cards.nth(i).locator("p").first();
      const text = (await titleEl.textContent() ?? "").replace(/^#\d+\s*/, "").trim();
      if (text.startsWith("Sort-")) ourTitles.push(text);
    }

    const positionOf = (prefix: string) =>
      ourTitles.findIndex((t) => t.startsWith(prefix));

    const bugPos = positionOf("Sort-Bug-");
    const featurePos = positionOf("Sort-Feature-");
    const taskPos = positionOf("Sort-Task-");
    const chorePos = positionOf("Sort-Chore-");

    // All four issues must be visible
    expect(bugPos).toBeGreaterThanOrEqual(0);
    expect(featurePos).toBeGreaterThanOrEqual(0);
    expect(taskPos).toBeGreaterThanOrEqual(0);
    expect(chorePos).toBeGreaterThanOrEqual(0);

    // Verify type order: bug < feature < task < chore (lower index = earlier)
    expect(bugPos).toBeLessThan(featurePos);
    expect(featurePos).toBeLessThan(taskPos);
    expect(taskPos).toBeLessThan(chorePos);
  });

  test("sort preference persists across page reload", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("col-sort-")) localStorage.removeItem(key);
      }
    });

    const todoCol = await findTodoColumn(page);
    await todoCol.locator('button[title="Sort by type"]').click();
    await expect(
      todoCol.locator('button[title="Sorted by type — click for default"]'),
    ).toBeVisible();

    // Reload and verify sort is still active
    await page.reload();
    // Wait for board to fully render (not just column headings)
    await page.waitForSelector('button[title="Sort by type"], button[title="Sorted by type — click for default"]');
    const todoColAfterReload = await findTodoColumn(page);
    await expect(
      todoColAfterReload.locator(
        'button[title="Sorted by type — click for default"]',
      ),
    ).toBeVisible();
  });

  test("toggling back to default restores original order", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("col-sort-")) localStorage.removeItem(key);
      }
    });

    const todoCol = await findTodoColumn(page);

    // Record default order for our test issues
    async function collectSortTitles(col: import("@playwright/test").Locator) {
      const cards = col.locator(".bg-white.rounded-md");
      const n = await cards.count();
      const titles: string[] = [];
      for (let i = 0; i < n; i++) {
        const text = (await cards.nth(i).locator("p").first().textContent() ?? "")
          .replace(/^#\d+\s*/, "").trim();
        if (text.startsWith("Sort-")) titles.push(text);
      }
      return titles;
    }
    const defaultTitles = await collectSortTitles(todoCol);

    // Enable type sort
    await todoCol.locator('button[title="Sort by type"]').click();
    await expect(
      todoCol.locator('button[title="Sorted by type — click for default"]'),
    ).toBeVisible();

    // Disable type sort
    await todoCol
      .locator('button[title="Sorted by type — click for default"]')
      .click();
    await expect(
      todoCol.locator('button[title="Sort by type"]'),
    ).toBeVisible();

    // Order should match default again
    const restoredTitles = await collectSortTitles(todoCol);
    expect(restoredTitles).toEqual(defaultTitles);
  });

  test("sort button is present in In Progress and In Review columns", async ({
    page,
  }) => {
    if (!inProgressStatusId || !inReviewStatusId) {
      test.skip();
      return;
    }

    await page.goto("/");
    await page.waitForSelector("h2");

    const activeColumnNames = ["In Progress", "In Review"];
    const columns = page.locator(".bg-gray-100.rounded-xl");
    const count = await columns.count();

    for (let i = 0; i < count; i++) {
      const col = columns.nth(i);
      const heading = await col.locator("h2").textContent();
      const name = heading?.replace(/\s*\d+$/, "").trim();
      if (activeColumnNames.includes(name ?? "")) {
        // Sort button must exist (may be inactive)
        const sortBtn = col.locator(
          'button[title="Sort by type"], button[title="Sorted by type — click for default"]',
        );
        await expect(sortBtn).toBeVisible();
      }
    }
  });

  test("sort is independent per column", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("col-sort-")) localStorage.removeItem(key);
      }
    });
    await page.waitForSelector("h2");

    // Find Todo and In Progress columns
    const columns = page.locator(".bg-gray-100.rounded-xl");
    const count = await columns.count();
    let todoCol: import("@playwright/test").Locator | null = null;
    let inProgressCol: import("@playwright/test").Locator | null = null;

    for (let i = 0; i < count; i++) {
      const col = columns.nth(i);
      const heading = await col.locator("h2").textContent();
      const name = heading?.replace(/\s*\d+$/, "").trim();
      if (name === "Todo") todoCol = col;
      if (name === "In Progress") inProgressCol = col;
    }

    if (!todoCol || !inProgressCol) {
      test.skip();
      return;
    }

    // Enable type sort only for Todo
    await todoCol.locator('button[title="Sort by type"]').click();
    await expect(
      todoCol.locator('button[title="Sorted by type — click for default"]'),
    ).toBeVisible();

    // In Progress column should remain in default sort
    await expect(
      inProgressCol.locator('button[title="Sort by type"]'),
    ).toBeVisible();
    await expect(
      inProgressCol.locator(
        'button[title="Sorted by type — click for default"]',
      ),
    ).toHaveCount(0);
  });
});
