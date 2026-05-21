import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Graph and Table board views", () => {
  let projectId: string;
  let todoStatusId: string;
  let doneStatusId: string;
  let suffix: string;
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    // Use the active project so issues appear on the board the browser shows
    const prefRes = await request.get(`${SERVER_URL}/api/preferences/active-project`);
    const pref = await prefRes.json();
    projectId = pref.projectId;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    const doneStatus = statuses.find((s: { name: string }) => s.name === "Done");
    todoStatusId = todoStatus ? todoStatus.id : statuses[0].id;
    doneStatusId = doneStatus ? doneStatus.id : statuses[3].id;

    suffix = Date.now().toString(36);

    const r1 = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `GraphTableA ${suffix}`, statusId: todoStatusId, projectId },
    });
    createdIssueIds.push((await r1.json()).id);

    const r2 = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `GraphTableB ${suffix}`, statusId: todoStatusId, projectId },
    });
    createdIssueIds.push((await r2.json()).id);

    const r3 = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `GraphTableDone ${suffix}`, statusId: doneStatusId, projectId },
    });
    createdIssueIds.push((await r3.json()).id);
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  // ---------------------------------------------------------------------------
  // Table view
  // ---------------------------------------------------------------------------

  test("switch to Table view via header toggle", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    await page.locator("button", { hasText: "Table" }).click();
    await expect(page.locator("table")).toBeVisible();

    // Button should be active (blue)
    await expect(page.locator("button", { hasText: "Table" })).toHaveClass(
      /bg-blue-600/,
    );
  });

  test("Table view renders expected column headers", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator("button", { hasText: "Table" }).click();
    await expect(page.locator("table")).toBeVisible();

    const headers = page.locator("thead th");
    const texts = await headers.allTextContents();
    const normalized = texts.map((t) => t.trim().replace(/[↑↓↕]/g, "").trim());
    expect(normalized).toContain("#");
    expect(normalized).toContain("Title");
    expect(normalized).toContain("Status");
    expect(normalized).toContain("Priority");
    expect(normalized).toContain("Estimate");
  });

  test("Table view shows test issues in rows", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator("button", { hasText: "Table" }).click();

    // Select "All statuses" so Done issues are visible too
    await page.locator("select.text-xs").selectOption("all");

    await expect(
      page.locator("tbody td", { hasText: `GraphTableA ${suffix}` }).first(),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator("tbody td", { hasText: `GraphTableB ${suffix}` }).first(),
    ).toBeVisible({ timeout: 5000 });
  });

  test("clicking a sortable column header changes sort order", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator("button", { hasText: "Table" }).click();
    await expect(page.locator("table")).toBeVisible();

    const titleHeader = page.locator("thead th", { hasText: "Title" });
    // First click — ascending
    await titleHeader.click();
    const iconAsc = await titleHeader.textContent();
    expect(iconAsc).toMatch(/↑|↓/);

    // Second click — descending (sort flips)
    await titleHeader.click();
    const iconDesc = await titleHeader.textContent();
    expect(iconDesc).toMatch(/↑|↓/);
    expect(iconAsc).not.toEqual(iconDesc);
  });

  test("status filter dropdown filters visible rows", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator("button", { hasText: "Table" }).click();
    await expect(page.locator("table")).toBeVisible();

    // Show all so Done row is present
    await page.locator("select.text-xs").selectOption("all");
    const allRowCount = await page.locator("tbody tr").count();

    // Filter to Done only
    await page.locator("select.text-xs").selectOption("Done");
    const doneRowCount = await page.locator("tbody tr").count();

    expect(doneRowCount).toBeLessThan(allRowCount);

    // Done issue should be visible, Todo issues should not
    await expect(
      page.locator("tbody td", { hasText: `GraphTableDone ${suffix}` }).first(),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator("tbody td", { hasText: `GraphTableA ${suffix}` }),
    ).not.toBeVisible();
  });

  test("clicking a table row opens the detail panel", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator("button", { hasText: "Table" }).click();
    await expect(page.locator("table")).toBeVisible();

    // Ensure our test issue is visible
    await page.locator("select.text-xs").selectOption("all");
    const row = page
      .locator("tbody tr", { hasText: `GraphTableA ${suffix}` })
      .first();
    await expect(row).toBeVisible({ timeout: 5000 });
    await row.click();

    // Detail panel should appear (contains the issue title)
    await expect(
      page.locator(`text=GraphTableA ${suffix}`).nth(1),
    ).toBeVisible({ timeout: 5000 });
  });

  // ---------------------------------------------------------------------------
  // Graph view
  // ---------------------------------------------------------------------------

  test("switch to Graph view via header toggle", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    await page.locator("button", { hasText: "Graph" }).click();
    await expect(page.locator(".bg-gray-50.select-none")).toBeVisible({ timeout: 5000 });

    // Button should be active (blue)
    await expect(page.locator("button", { hasText: "Graph" })).toHaveClass(
      /bg-blue-600/,
    );
  });

  test("Graph view renders nodes for active issues", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator("button", { hasText: "Graph" }).click();
    await expect(page.locator(".bg-gray-50.select-none")).toBeVisible({ timeout: 5000 });

    // Nodes should exist — at minimum our two Todo test issues
    const nodes = page.locator("[data-node]");
    await expect(nodes.first()).toBeVisible({ timeout: 5000 });
    const count = await nodes.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("status legend is visible in Graph view", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator("button", { hasText: "Graph" }).click();
    await expect(page.locator(".bg-gray-50.select-none")).toBeVisible({ timeout: 5000 });

    // Legend box contains a "Status" heading
    await expect(page.locator("text=Status").first()).toBeVisible({ timeout: 5000 });
    // And lists known status names
    await expect(page.locator("text=Todo").first()).toBeVisible({ timeout: 5000 });
  });

  test("Show completed toggle reveals Done nodes", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator("button", { hasText: "Graph" }).click();
    await expect(page.locator(".bg-gray-50.select-none")).toBeVisible({ timeout: 5000 });

    // Initially archive nodes are hidden; Done issue should not appear as a node
    const nodesBefore = await page.locator("[data-node]").count();

    // Click "Show completed"
    await page.locator("button", { hasText: "Show completed" }).click();
    await expect(page.locator("button", { hasText: "Hide completed" })).toBeVisible({ timeout: 3000 });

    // Node count should increase (Done issue is now visible)
    const nodesAfter = await page.locator("[data-node]").count();
    expect(nodesAfter).toBeGreaterThan(nodesBefore);
  });

  test("Hide completed toggle removes Done nodes", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator("button", { hasText: "Graph" }).click();
    await expect(page.locator(".bg-gray-50.select-none")).toBeVisible({ timeout: 5000 });

    // Expand
    await page.locator("button", { hasText: "Show completed" }).click();
    await expect(page.locator("button", { hasText: "Hide completed" })).toBeVisible({ timeout: 3000 });
    const nodesExpanded = await page.locator("[data-node]").count();

    // Collapse
    await page.locator("button", { hasText: "Hide completed" }).click();
    await expect(page.locator("button", { hasText: "Show completed" })).toBeVisible({ timeout: 3000 });
    const nodesCollapsed = await page.locator("[data-node]").count();

    expect(nodesCollapsed).toBeLessThan(nodesExpanded);
  });

  test("zoom in button increases scale transform", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator("button", { hasText: "Graph" }).click();
    await expect(page.locator(".bg-gray-50.select-none")).toBeVisible({ timeout: 5000 });

    const getScale = () =>
      page.evaluate(() => {
        const container = document.querySelector(".bg-gray-50.select-none");
        const g = container ? container.querySelector("svg > g") : null;
        if (!g) return 1;
        const t = g.getAttribute("transform") || "";
        const m = t.match(/scale\(([^)]+)\)/);
        return m ? parseFloat(m[1]) : 1;
      });

    const scaleBefore = await getScale();
    await page.locator("button", { hasText: "+" }).click();
    const scaleAfter = await getScale();
    expect(scaleAfter).toBeGreaterThan(scaleBefore);
  });

  test("zoom out button decreases scale transform", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator("button", { hasText: "Graph" }).click();
    await expect(page.locator(".bg-gray-50.select-none")).toBeVisible({ timeout: 5000 });

    const getScale = () =>
      page.evaluate(() => {
        const container = document.querySelector(".bg-gray-50.select-none");
        const g = container ? container.querySelector("svg > g") : null;
        if (!g) return 1;
        const t = g.getAttribute("transform") || "";
        const m = t.match(/scale\(([^)]+)\)/);
        return m ? parseFloat(m[1]) : 1;
      });

    // Zoom in first so there's room to zoom out
    await page.locator("button", { hasText: "+" }).click();
    await page.locator("button", { hasText: "+" }).click();
    const scaleBefore = await getScale();
    await page.locator("button", { hasText: "−" }).click();
    const scaleAfter = await getScale();
    expect(scaleAfter).toBeLessThan(scaleBefore);
  });

  test("switching back to Board view from Graph restores kanban", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    await page.locator("button", { hasText: "Graph" }).click();
    await expect(page.locator(".bg-gray-50.select-none")).toBeVisible({ timeout: 5000 });

    await page.locator("button", { hasText: "Board" }).click();

    // Kanban columns should be visible again
    await expect(page.locator("h2", { hasText: "Todo" }).first()).toBeVisible({ timeout: 5000 });
    // Graph-specific nodes should not be present
    await expect(page.locator("[data-node]")).not.toBeVisible();
  });
});
