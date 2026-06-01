import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Graph and Table board views", () => {
  let projectId: string;
  let backlogStatusId: string;
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
    let statuses = await statusesRes.json();
    let backlogStatus = statuses.find((s: { name: string }) => s.name === "Backlog");
    if (!backlogStatus) {
      const backlogRes = await request.post(
        `${SERVER_URL}/api/projects/${projectId}/statuses`,
        { data: { name: "Backlog", sortOrder: -1 } },
      );
      backlogStatus = await backlogRes.json();
      const refreshedStatusesRes = await request.get(
        `${SERVER_URL}/api/projects/${projectId}/statuses`,
      );
      statuses = await refreshedStatusesRes.json();
    }
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    const doneStatus = statuses.find((s: { name: string }) => s.name === "Done");
    backlogStatusId = backlogStatus.id;
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

    const r4 = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `GraphTableBacklog ${suffix}`, statusId: backlogStatusId, projectId },
    });
    createdIssueIds.push((await r4.json()).id);
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
      /bg-(blue|brand)-600/,
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
    await page.getByLabel("Table status filter").selectOption("all");

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
    await page.getByLabel("Table status filter").selectOption("all");
    const allRowCount = await page.locator("tbody tr").count();

    // Filter to Done only
    await page.getByLabel("Table status filter").selectOption("Done");
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
    await page.getByLabel("Table status filter").selectOption("all");
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
      /bg-(blue|brand)-600/,
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

  test("Graph view hides backlog and completed issues by default", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator("button", { hasText: "Graph" }).click();
    await expect(page.locator(".bg-gray-50.select-none")).toBeVisible({ timeout: 5000 });

    await expect(page.getByText(`GraphTableA ${suffix}`).first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(`GraphTableBacklog ${suffix}`)).not.toBeVisible();
    await expect(page.getByText(`GraphTableDone ${suffix}`)).not.toBeVisible();
  });

  test("Graph status filter can show backlog issues", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator("button", { hasText: "Graph" }).click();
    await expect(page.locator(".bg-gray-50.select-none")).toBeVisible({ timeout: 5000 });

    await page.getByLabel("Graph status filter").selectOption("Backlog");
    await expect(page.getByText(`GraphTableBacklog ${suffix}`).first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(`GraphTableA ${suffix}`)).not.toBeVisible();
  });

  test("Graph status filter can show multiple selected statuses", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator("button", { hasText: "Graph" }).click();
    await expect(page.locator(".bg-gray-50.select-none")).toBeVisible({ timeout: 5000 });

    await page.getByLabel("Graph status filter").selectOption(["Todo", "Backlog"]);
    await expect(page.getByText(`GraphTableA ${suffix}`).first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(`GraphTableBacklog ${suffix}`).first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(`GraphTableDone ${suffix}`)).not.toBeVisible();
  });

  test("Graph status filter can show all statuses", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator("button", { hasText: "Graph" }).click();
    await expect(page.locator(".bg-gray-50.select-none")).toBeVisible({ timeout: 5000 });

    const activeCount = await page.locator("[data-node]").count();
    await page.getByLabel("Graph status filter").selectOption("all");
    await expect(page.getByText(`GraphTableBacklog ${suffix}`).first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(`GraphTableDone ${suffix}`).first()).toBeVisible({ timeout: 5000 });
    const allCount = await page.locator("[data-node]").count();
    expect(allCount).toBeGreaterThan(activeCount);
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

// ---------------------------------------------------------------------------
// Critical Path mode
// ---------------------------------------------------------------------------

test.describe("Critical Path mode", () => {
  let projectId: string;
  let todoStatusId: string;
  let suffix: string;
  const createdIssueIds: string[] = [];
  const createdDeps: Array<{ issueId: string; depId: string }> = [];

  test.beforeAll(async ({ request }) => {
    const prefRes = await request.get(`${SERVER_URL}/api/preferences/active-project`);
    const pref = await prefRes.json();
    projectId = pref.projectId;

    const statusesRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    todoStatusId = todoStatus ? todoStatus.id : statuses[0].id;

    suffix = Date.now().toString(36);

    // Create a chain: rootA → childB → childC
    const rA = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `CPRoot ${suffix}`, statusId: todoStatusId, projectId },
    });
    const issueAId = (await rA.json()).id;
    createdIssueIds.push(issueAId);

    const rB = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `CPChild ${suffix}`, statusId: todoStatusId, projectId },
    });
    const issueBId = (await rB.json()).id;
    createdIssueIds.push(issueBId);

    const rC = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `CPEnd ${suffix}`, statusId: todoStatusId, projectId },
    });
    const issueCId = (await rC.json()).id;
    createdIssueIds.push(issueCId);

    // B depends on A (A blocks B)
    const depRes1 = await request.post(`${SERVER_URL}/api/issues/${issueBId}/dependencies`, {
      data: { dependsOnId: issueAId, type: "depends_on" },
    });
    if (depRes1.ok()) createdDeps.push({ issueId: issueBId, depId: (await depRes1.json()).id });

    // C depends on B (B blocks C)
    const depRes2 = await request.post(`${SERVER_URL}/api/issues/${issueCId}/dependencies`, {
      data: { dependsOnId: issueBId, type: "depends_on" },
    });
    if (depRes2.ok()) createdDeps.push({ issueId: issueCId, depId: (await depRes2.json()).id });
  });

  test.afterAll(async ({ request }) => {
    // Remove dependencies first (issue ID required in path)
    for (const { issueId, depId } of createdDeps) {
      try { await request.delete(`${SERVER_URL}/api/issues/${issueId}/dependencies/${depId}`); } catch {}
    }
    // Then remove issues
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  test("Critical Path toggle is visible when dependencies exist", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    await page.locator("button", { hasText: "Graph" }).click();
    await expect(page.locator(".bg-gray-50.select-none")).toBeVisible({ timeout: 5000 });

    // The "Critical Path" button should be visible
    await expect(page.locator("button", { hasText: "Critical Path" })).toBeVisible({ timeout: 5000 });
  });

  test("Clicking Critical Path switches to critical-path mode", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    await page.locator("button", { hasText: "Graph" }).click();
    await expect(page.locator(".bg-gray-50.select-none")).toBeVisible({ timeout: 5000 });

    await page.locator("button", { hasText: "Critical Path" }).click();

    // The Critical Path button should now be active (brand-600)
    await expect(page.locator("button", { hasText: "Critical Path" })).toHaveClass(
      /bg-brand-600/,
    );

    // Root blocker node should have the data attribute
    const rootNodes = page.locator("[data-critical-path-root]");
    await expect(rootNodes.first()).toBeVisible({ timeout: 5000 });
  });

  test("Root blocker nodes show downstream count badge", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    await page.locator("button", { hasText: "Graph" }).click();
    await expect(page.locator(".bg-gray-50.select-none")).toBeVisible({ timeout: 5000 });

    await page.locator("button", { hasText: "Critical Path" }).click();

    // Look for the badge circle (fills with ROOT_BLOCKER_COLOR #b4453a)
    const badges = page.locator("[data-critical-path-root] circle");
    await expect(badges.first()).toBeVisible({ timeout: 5000 });
  });

  test("Clicking a root blocker opens chain side panel", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    await page.locator("button", { hasText: "Graph" }).click();
    await expect(page.locator(".bg-gray-50.select-none")).toBeVisible({ timeout: 5000 });

    await page.locator("button", { hasText: "Critical Path" }).click();

    // Click the root blocker node
    const rootNodes = page.locator("[data-critical-path-root]");
    await expect(rootNodes.first()).toBeVisible({ timeout: 5000 });
    await rootNodes.first().click();

    // Side panel should appear with "Critical Path" heading
    await expect(page.locator("text=Critical Path").first()).toBeVisible({ timeout: 5000 });

    // Chain steps should show our issue titles
    await expect(page.locator(`text=CPRoot ${suffix}`).first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator(`text=CPChild ${suffix}`).first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator(`text=CPEnd ${suffix}`).first()).toBeVisible({ timeout: 5000 });
  });

  test("Toggling back to Graph restores normal rendering", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    await page.locator("button", { hasText: "Graph" }).click();
    await expect(page.locator(".bg-gray-50.select-none")).toBeVisible({ timeout: 5000 });

    // Switch to critical path
    await page.locator("button", { hasText: "Critical Path" }).click();
    await expect(page.locator("[data-critical-path-root]").first()).toBeVisible({ timeout: 5000 });

    // Switch back to normal graph
    await page.locator("button", { hasText: "Graph" }).click();

    // Root blocker attribute should no longer be present (re-rendered without critical path mode)
    await expect(page.locator("[data-critical-path-root]")).not.toBeVisible({ timeout: 5000 });
  });
});
