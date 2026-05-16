import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Search UI", () => {
  let projectId: string;
  let todoStatusId: string;
  let inProgressStatusId: string;
  let suffix: string;
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();
    projectId = projects[0].id;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    const inProgressStatus = statuses.find((s: { name: string }) => s.name === "In Progress");
    todoStatusId = todoStatus ? todoStatus.id : statuses[0].id;
    inProgressStatusId = inProgressStatus ? inProgressStatus.id : statuses[1].id;

    suffix = Date.now().toString(36);
    const a = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `SearchAlpha ${suffix}`,
        description: "Alpha description for search",
        priority: "high",
        statusId: todoStatusId,
        projectId,
      },
    });
    createdIssueIds.push((await a.json()).id);

    const b = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `SearchBeta ${suffix}`,
        description: "Beta description for search",
        priority: "medium",
        statusId: todoStatusId,
        projectId,
      },
    });
    createdIssueIds.push((await b.json()).id);

    const g = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `SearchGamma ${suffix}`,
        description: "Gamma description for search",
        priority: "low",
        statusId: inProgressStatusId,
        projectId,
      },
    });
    createdIssueIds.push((await g.json()).id);
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  test("typing in search box filters issue cards", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    // Type into search input
    const searchInput = page.locator("#search-input");
    await searchInput.fill("SearchAlpha");

    // Wait for filtering to apply
    await page.waitForTimeout(300);

    // Only the matching card should be visible (check by text presence)
    const suffix = await page.evaluate(() => {
      const el = document.querySelector("#search-input") as HTMLInputElement;
      return el?.value ?? "";
    });
    // The search input should have the typed value
    await expect(searchInput).toHaveValue("SearchAlpha");

    // SearchBeta and SearchGamma cards should not be visible
    await expect(
      page.locator("p", { hasText: "SearchBeta" }).first(),
    ).not.toBeVisible();
    await expect(
      page.locator("p", { hasText: "SearchGamma" }).first(),
    ).not.toBeVisible();
  });

  test("search highlights matching text with mark element", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    // Type a query that matches part of the issue title
    const searchInput = page.locator("#search-input");
    await searchInput.fill("SearchAlpha");

    // Wait for filtering and highlighting
    await page.waitForTimeout(300);

    // The matching card should have a <mark> element with the highlighted text
    const markElements = page.locator("mark");
    await expect(markElements.first()).toBeVisible({ timeout: 5000 });

    // The mark should contain text that matches (case-insensitive)
    const markText = await markElements.first().textContent();
    expect(markText?.toLowerCase()).toContain("searchalpha");
  });

  test("clearing search shows all cards again", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    // First filter to one result
    const searchInput = page.locator("#search-input");
    await searchInput.fill("SearchAlpha");
    await page.waitForTimeout(300);

    // Only one card visible
    await expect(
      page.locator("p", { hasText: "SearchBeta" }).first(),
    ).not.toBeVisible();

    // Clear the search
    await searchInput.clear();
    await page.waitForTimeout(300);

    // All cards should be visible again
    await expect(
      page.locator("p", { hasText: "SearchBeta" }).first(),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator("p", { hasText: "SearchGamma" }).first(),
    ).toBeVisible({ timeout: 5000 });
  });

  test("clear button in search input clears the query", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    const searchInput = page.locator("#search-input");
    await searchInput.fill("SearchAlpha");

    // The clear (x) button should appear
    const clearBtn = searchInput.locator("..").locator("button");
    await expect(clearBtn).toBeVisible();
    await clearBtn.click();

    // Search input should be empty
    await expect(searchInput).toHaveValue("");
  });

  test("priority dropdown filter works", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    // Select "high" priority filter
    const prioritySelect = page.locator("select").last();
    await prioritySelect.selectOption("high");

    await page.waitForTimeout(300);

    // Only high priority issues should be visible
    // SearchAlpha (high) should be visible; SearchBeta (medium) and SearchGamma (low) should not
    await expect(
      page.locator("p", { hasText: "SearchBeta" }).first(),
    ).not.toBeVisible();
    await expect(
      page.locator("p", { hasText: "SearchGamma" }).first(),
    ).not.toBeVisible();

    // Switch back to "all priorities"
    await prioritySelect.selectOption("");
    await page.waitForTimeout(300);

    // All should be visible again
    await expect(
      page.locator("p", { hasText: "SearchBeta" }).first(),
    ).toBeVisible({ timeout: 5000 });
  });

  test("search and priority filter combine", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    // Set search query that matches multiple issues (via "description for search")
    const searchInput = page.locator("#search-input");
    await searchInput.fill("description for search");
    await page.waitForTimeout(300);

    // Multiple cards should match the text search
    const matchingCards = page.locator(".bg-white.rounded-md.shadow-sm");
    const countBeforeFilter = await matchingCards.count();
    expect(countBeforeFilter).toBeGreaterThanOrEqual(2);

    // Now also filter by "low" priority — only SearchGamma should remain
    const prioritySelect = page.locator("select").last();
    await prioritySelect.selectOption("low");
    await page.waitForTimeout(300);

    // Only SearchGamma (low priority) should be visible
    await expect(
      page.locator("p", { hasText: "SearchGamma" }).first(),
    ).toBeVisible();
    await expect(
      page.locator("p", { hasText: "SearchAlpha" }).first(),
    ).not.toBeVisible();
    await expect(
      page.locator("p", { hasText: "SearchBeta" }).first(),
    ).not.toBeVisible();
  });
});
