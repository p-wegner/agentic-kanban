import { test, expect } from "@playwright/test";

test.describe("Board UI", () => {
  test("shows kanban columns with expected names", async ({ page }) => {
    await page.goto("/");

    // Wait for the board to load
    await page.waitForSelector("h2");

    const columns = page.locator("h2");
    const count = await columns.count();
    expect(count).toBeGreaterThanOrEqual(5);

    // Verify the 5 default column names are present
    const names = (await columns.allTextContents()).map((n) =>
      n.replace(/\s*\d+$/, "").trim(),
    );
    expect(names).toContain("Todo");
    expect(names).toContain("In Progress");
    expect(names).toContain("In Review");
    expect(names).toContain("Done");
    expect(names).toContain("Cancelled");
  });

  test("shows header with title", async ({ page }) => {
    await page.goto("/");
    const header = page.locator("header h1");
    await expect(header).toHaveText("Agentic Kanban");
  });
});

test.describe("Board interactions", () => {
  test("create issue via inline form", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    // Click "+" on the first column (Todo)
    const firstColumn = page.locator(".flex-shrink-0.w-72").first();
    await firstColumn.locator("button[title='Add issue']").click();

    // Fill the form
    const form = page.locator("form");
    await form
      .locator("input[placeholder='Issue title']")
      .fill("E2E Test Issue Unique 123");
    await form
      .locator("textarea[placeholder='Description (optional)']")
      .fill("Created by e2e test");
    await form.locator("select").selectOption("high");
    await form.locator('button:has-text("Add")').click();

    // Verify the issue appears (use .first() to avoid strict mode with title + description match)
    await expect(
      page.locator("p", { hasText: "E2E Test Issue Unique 123" }).first(),
    ).toBeVisible();
  });

  test("cancel create form", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    // Click "+" on the first column
    const firstColumn = page.locator(".flex-shrink-0.w-72").first();
    await firstColumn.locator("button[title='Add issue']").click();

    // Verify form appears
    await expect(page.locator("form")).toBeVisible();

    // Click Cancel
    await page.locator('button:has-text("Cancel")').click();

    // Form should be gone
    await expect(page.locator("form")).not.toBeVisible();
  });

  test("open detail panel by clicking issue card", async ({
    page,
    request,
  }) => {
    // Create an issue via API first
    const projectsRes = await request.get("http://localhost:3001/api/projects");
    const projects = await projectsRes.json();
    const projectId = projects[0].id;
    const statusesRes = await request.get(
      `http://localhost:3001/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    const statusId = todoStatus ? todoStatus.id : statuses[0].id;

    await request.post("http://localhost:3001/api/issues", {
      data: {
        title: "PanelClickTest 999",
        description: "Click me",
        priority: "medium",
        statusId,
        projectId,
      },
    });

    await page.goto("/");
    await page.waitForSelector("h2");

    // Click the issue card (use .first() to handle any duplicates from prior tests)
    await page.locator("p", { hasText: "PanelClickTest 999" }).first().click();

    // Panel should be visible with heading
    await expect(
      page.locator("h2", { hasText: "Issue Details" }),
    ).toBeVisible();
    await expect(
      page.locator("h3", { hasText: "PanelClickTest 999" }),
    ).toBeVisible();
    await expect(page.locator(".whitespace-pre-wrap", { hasText: "Click me" })).toBeVisible();
  });

  test("edit issue from detail panel", async ({ page, request }) => {
    // Create an issue via API
    const projectsRes = await request.get("http://localhost:3001/api/projects");
    const projects = await projectsRes.json();
    const projectId = projects[0].id;
    const statusesRes = await request.get(
      `http://localhost:3001/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    // Use the "Todo" status specifically
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    const statusId = todoStatus ? todoStatus.id : statuses[0].id;

    await request.post("http://localhost:3001/api/issues", {
      data: {
        title: "EditTestIssue 888",
        description: "Before edit",
        priority: "low",
        statusId,
        projectId,
      },
    });

    await page.goto("/");
    await page.waitForSelector("h2");

    // Click the issue card
    await page.locator("p", { hasText: "EditTestIssue 888" }).first().click();
    await expect(
      page.locator("h2", { hasText: "Issue Details" }),
    ).toBeVisible();

    // Click Edit
    await page.locator('button:has-text("Edit")').click();
    await expect(page.locator("text=Edit Issue")).toBeVisible();

    // Change the title — use the panel's right-side container to scope the input
    const panel = page.locator(".fixed.right-0");
    const titleInput = panel.locator('input[type="text"]').first();
    await titleInput.clear();
    await titleInput.fill("Edited Title 777");

    // Save
    await page.locator('button:has-text("Save")').click();

    // Panel closes
    await expect(
      page.locator("h2", { hasText: "Issue Details" }),
    ).not.toBeVisible();

    // Verify the edited title appears on the board
    await expect(
      page.locator("p", { hasText: "Edited Title 777" }),
    ).toBeVisible({ timeout: 10000 });
  });

  test("delete issue from detail panel", async ({ page, request }) => {
    // Create an issue via API
    const projectsRes = await request.get("http://localhost:3001/api/projects");
    const projects = await projectsRes.json();
    const projectId = projects[0].id;
    const statusesRes = await request.get(
      `http://localhost:3001/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    const statusId = todoStatus ? todoStatus.id : statuses[0].id;

    await request.post("http://localhost:3001/api/issues", {
      data: {
        title: "DeleteTestIssue 666",
        statusId,
        projectId,
      },
    });

    await page.goto("/");
    await page.waitForSelector("h2");

    // Click the issue card
    await page.locator("p", { hasText: "DeleteTestIssue 666" }).first().click();
    await expect(
      page.locator("h2", { hasText: "Issue Details" }),
    ).toBeVisible();

    // Click Delete (first click shows confirm)
    await page.locator('button:has-text("Delete")').click();
    await expect(
      page.locator('button:has-text("Confirm Delete")'),
    ).toBeVisible();

    // Confirm delete
    await page.locator('button:has-text("Confirm Delete")').click();

    // Panel closes and issue card is gone from board
    await expect(
      page.locator("p", { hasText: "DeleteTestIssue 666" }),
    ).not.toBeVisible({ timeout: 5000 });
  });

  test("escape closes detail panel", async ({ page, request }) => {
    // Create an issue via API
    const projectsRes = await request.get("http://localhost:3001/api/projects");
    const projects = await projectsRes.json();
    const projectId = projects[0].id;
    const statusesRes = await request.get(
      `http://localhost:3001/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    const statusId = todoStatus ? todoStatus.id : statuses[0].id;

    await request.post("http://localhost:3001/api/issues", {
      data: {
        title: "EscapeTestIssue 555",
        statusId,
        projectId,
      },
    });

    await page.goto("/");
    await page.waitForSelector("h2");

    // Click the issue card
    await page.locator("p", { hasText: "EscapeTestIssue 555" }).first().click();
    await expect(
      page.locator("h2", { hasText: "Issue Details" }),
    ).toBeVisible();

    // Press Escape
    await page.keyboard.press("Escape");

    // Panel should close
    await expect(
      page.locator("h2", { hasText: "Issue Details" }),
    ).not.toBeVisible();
  });

  test("drag issue between columns", async ({ page, request }) => {
    // Create an issue in Todo
    const projectsRes = await request.get("http://localhost:3001/api/projects");
    const projects = await projectsRes.json();
    const projectId = projects[0].id;
    const statuses = (
      await (
        await request.get(
          `http://localhost:3001/api/projects/${projectId}/statuses`,
        )
      ).json()
    );
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    const inProgressStatus = statuses.find((s: { name: string }) => s.name === "In Progress");
    const todoStatusId = todoStatus ? todoStatus.id : statuses[0].id;
    const inProgressStatusId = inProgressStatus ? inProgressStatus.id : statuses[1].id;

    const createRes = await request.post("http://localhost:3001/api/issues", {
      data: {
        title: "DragTestIssue 444",
        projectId,
        statusId: todoStatusId,
      },
    });
    const { id: issueId } = await createRes.json();

    await page.goto("/");
    await page.waitForSelector("h2");

    // Set up drag data and simulate drop via JS evaluation
    await page.evaluate(
      ({ iid, srcId, tgtId }) => {
        // Set the drag bridge data
        (window as unknown as Record<string, unknown>).__dragData = {
          issueId: iid,
          sourceStatusId: srcId,
        };

        // Find the "In Progress" column by its heading text
        const columns = document.querySelectorAll(".flex-shrink-0.w-72");
        let targetCol: Element | null = null;
        for (const col of columns) {
          const h2 = col.querySelector("h2");
          if (h2 && h2.textContent?.includes("In Progress")) {
            targetCol = col;
            break;
          }
        }
        if (!targetCol) throw new Error("In Progress column not found");

        const dropEvent = new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(dropEvent, "dataTransfer", {
          value: new DataTransfer(),
        });
        targetCol.dispatchEvent(dropEvent);
      },
      { iid: issueId, srcId: todoStatusId, tgtId: inProgressStatusId },
    );

    // Wait for the API call and board refresh
    await page.waitForTimeout(1000);

    // Verify via API that the issue moved
    const boardRes = await request.get(
      `http://localhost:3001/api/projects/${projectId}/board`,
    );
    const board = await boardRes.json();
    const inProgressColumn = board.find((s: { name: string }) => s.name === "In Progress");
    const movedIssue = inProgressColumn.issues.find(
      (i: { title: string }) => i.title === "DragTestIssue 444",
    );
    expect(movedIssue).toBeDefined();
  });

  test("error banner on API failure", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    // Intercept POST /api/issues to return 500
    await page.route("**/api/issues", (route) => {
      if (route.request().method() === "POST") {
        route.fulfill({ status: 500, body: "Server error" });
      } else {
        route.continue();
      }
    });

    // Click "+" and try to create
    const firstColumn = page.locator(".flex-shrink-0.w-72").first();
    await firstColumn.locator("button[title='Add issue']").click();
    const form = page.locator("form");
    await form
      .locator("input[placeholder='Issue title']")
      .fill("Should Fail");
    await form.locator('button:has-text("Add")').click();

    // Toast notification should appear
    await expect(page.locator("text=Failed to create issue")).toBeVisible();
  });
});
