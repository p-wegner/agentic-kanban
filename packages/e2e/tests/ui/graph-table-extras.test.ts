import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

// #207 — coverage for the Graph-view "Fit to view" (zoom-to-fit) control AND
// the Table-view "Tags" + "Updated" columns. The basic graph/table view
// switching and zoom +/- buttons are already covered by graph-table-views.test.ts;
// this file only adds the previously-uncovered extras.
//
// Source of every selector used here:
//   GraphView.tsx  — container `.bg-gray-50 ... select-none`; transform on `svg > g`
//                    is `translate(...) scale(${zoom})`; zoom-in button text "+";
//                    fit button `title="Fit to view"`.
//   TableView.tsx  — SORTABLE_COLUMNS includes ["updated", "Updated"]; a trailing
//                    `<th>` renders the literal "Tags"; rows render `formatDate(updatedAt)`
//                    and per-issue tag chips.

test.describe("Graph & Table view extras (#207)", () => {
  let projectId: string;
  let todoStatusId: string;
  let suffix: string;
  const createdIssueIds: string[] = [];

  async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    throw new Error(`[${label}] failed after 3 attempts: ${String(lastErr)}`);
  }

  test.beforeAll(async ({ request }) => {
    projectId = await withRetry(() => getE2EProjectId(request), "getE2EProjectId");

    const statuses = await withRetry(async () => {
      const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
      if (!res.ok()) throw new Error(`statuses ${res.status()}`);
      return res.json();
    }, "fetch statuses");
    const todo = statuses.find((s: { name: string }) => s.name === "Todo");
    todoStatusId = todo ? todo.id : statuses[0].id;

    suffix = Date.now().toString(36);

    // Two Todo issues so the graph has at least two nodes (zoom is meaningful).
    const ids: string[] = [];
    for (const name of [`GTXa ${suffix}`, `GTXb ${suffix}`]) {
      const issueId = await withRetry(async () => {
        const res = await request.post(`${SERVER_URL}/api/issues`, {
          data: { title: name, statusId: todoStatusId, projectId },
        });
        if (!res.ok()) throw new Error(`create issue ${res.status()}`);
        return (await res.json()).id;
      }, "create issue");
      createdIssueIds.push(issueId);
      ids.push(issueId);
    }

    // The default graph mode renders "No dependencies defined" (no nodes / no Fit
    // control) until at least one dependency edge exists. Link B → A so the dependency
    // graph actually draws nodes ([data-node]) and the zoom/fit toolbar.
    await withRetry(async () => {
      const res = await request.post(
        `${SERVER_URL}/api/issues/${ids[1]}/dependencies`,
        { data: { dependsOnId: ids[0], type: "depends_on" } },
      );
      if (!res.ok()) throw new Error(`create dependency ${res.status()}`);
      return res.json();
    }, "create dependency");
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  // ---------------------------------------------------------------------------
  // Table view — "Tags" and "Updated" columns
  // ---------------------------------------------------------------------------

  test("Table view renders the Tags and Updated column headers", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator('button[title="Table view (t)"]:not([tabindex="-1"])').click();
    await expect(page.locator("table")).toBeVisible();

    const headers = page.locator("thead th");
    const texts = await headers.allTextContents();
    // Strip sort-icon glyphs the same way graph-table-views.test.ts does.
    const normalized = texts.map((t) => t.trim().replace(/[↑↓↕]/g, "").trim());
    expect(normalized).toContain("Updated");
    expect(normalized).toContain("Tags");
  });

  test("Updated column is sortable (clicking the header toggles its sort icon)", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator('button[title="Table view (t)"]:not([tabindex="-1"])').click();
    await expect(page.locator("table")).toBeVisible();

    const updatedHeader = page.locator("thead th", { hasText: "Updated" });
    await updatedHeader.click();
    const iconAsc = (await updatedHeader.textContent()) ?? "";
    expect(iconAsc).toMatch(/↑|↓/);

    await updatedHeader.click();
    const iconDesc = (await updatedHeader.textContent()) ?? "";
    expect(iconDesc).toMatch(/↑|↓/);
    expect(iconAsc).not.toEqual(iconDesc);
  });

  test("Updated column renders a formatted date for a test issue row", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator('button[title="Table view (t)"]:not([tabindex="-1"])').click();
    await page.getByLabel("Table status filter").selectOption("all");

    const row = page.locator("tbody tr", { hasText: `GTXa ${suffix}` }).first();
    await expect(row).toBeVisible({ timeout: 5000 });

    // The Updated <th> is the 8th header (checkbox + #,Title,Status,Priority,Type,
    // Estimate,Updated). formatDate never produces an empty cell, so assert the
    // cell at that index has non-whitespace text.
    const headerTexts = (await page.locator("thead th").allTextContents()).map((t) =>
      t.trim().replace(/[↑↓↕]/g, "").trim(),
    );
    const updatedIdx = headerTexts.findIndex((t) => t === "Updated");
    expect(updatedIdx).toBeGreaterThan(0);
    const updatedCell = row.locator("td").nth(updatedIdx);
    await expect(updatedCell).toBeVisible();
    const cellText = (await updatedCell.textContent())?.trim() ?? "";
    expect(cellText.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Graph view — "Fit to view" (zoom-to-fit) control
  // ---------------------------------------------------------------------------

  test("Fit-to-view button is present in Graph view", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator('button[title="Graph view (g)"]:not([tabindex="-1"])').click();
    await expect(page.locator(".bg-gray-50.select-none")).toBeVisible({ timeout: 5000 });

    await expect(page.locator('button[title="Fit to view"]')).toBeVisible({ timeout: 5000 });
  });

  test("Fit-to-view resets the zoom after manual zoom-in", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator('button[title="Graph view (g)"]:not([tabindex="-1"])').click();
    await expect(page.locator(".bg-gray-50.select-none")).toBeVisible({ timeout: 5000 });

    // Make sure nodes exist so fitView() has bounds to compute.
    await expect(page.locator("[data-node]").first()).toBeVisible({ timeout: 5000 });

    const getScale = () =>
      page.evaluate(() => {
        const container = document.querySelector(".bg-gray-50.select-none");
        const g = container ? container.querySelector("svg > g") : null;
        if (!g) return 1;
        const t = g.getAttribute("transform") || "";
        const m = t.match(/scale\(([^)]+)\)/);
        return m ? parseFloat(m[1]) : 1;
      });

    // Zoom in several times to move scale away from any fitted value.
    const zoomIn = page.locator("button", { hasText: "+" });
    for (let i = 0; i < 3; i++) await zoomIn.click();
    const zoomedScale = await getScale();

    // Click Fit — fitView() recomputes scale from node bounds, so the transform
    // must change away from the zoomed-in value.
    await page.locator('button[title="Fit to view"]').click();

    await expect
      .poll(async () => await getScale(), { timeout: 5000 })
      .not.toBe(zoomedScale);
  });
});
