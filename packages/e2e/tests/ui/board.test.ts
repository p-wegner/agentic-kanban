import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

test.describe("Board UI", () => {
  test("shows kanban columns with expected names", async ({ page }) => {
    await page.goto("/");

    await page.waitForSelector("h2");

    const columns = page.locator("h2");
    const names = (await columns.allTextContents()).map((n) =>
      n.replace(/\s*\d+$/, "").trim(),
    );
    expect(names).toContain("Todo");
    expect(names).toContain("In Progress");
    expect(names).toContain("In Review");

    await page.locator("button", { hasText: "Completed" }).click();

    const allColumns = page.locator("h2");
    const allNames = (await allColumns.allTextContents()).map((n) =>
      n.replace(/\s*\d+$/, "").trim(),
    );
    expect(allNames).toContain("Done");
    expect(allNames).toContain("Cancelled");
  });

  test("shows header with title", async ({ page }) => {
    await page.goto("/");
    const header = page.locator("header h1");
    await expect(header).toHaveText("Agentic Kanban");
  });
});

test.describe("Board interactions", () => {
  let projectId: string;
  let statusId: string;
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    projectId = await getE2EProjectId(request);

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todoStatus ? todoStatus.id : statuses[0].id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`).catch(() => {});
    }
  });

  test("create issue via inline form", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const title = `E2E Create Test ${suffix}`;

    await page.goto("/");
    await page.waitForSelector("h2");

    const firstColumn = page.locator(".bg-gray-100.rounded-lg").first();
    await firstColumn.locator("button[title='Add issue']").click();

    const form = page.locator("form");
    await form
      .locator("input[placeholder='Issue title']")
      .fill(title);
    await form
      .locator("textarea[placeholder='Description (optional)']")
      .fill("Created by e2e test");
    await form.locator("select").selectOption("high");
    await form.locator('button:has-text("Add")').click();

    await expect(
      page.locator("p", { hasText: title }).first(),
    ).toBeVisible();

    // Fetch the created issue ID for cleanup
    const issuesRes = await request.get(
      `${SERVER_URL}/api/issues?projectId=${projectId}`,
    );
    const issues = await issuesRes.json();
    const created = issues.find((i: { title: string }) => i.title === title);
    if (created) createdIssueIds.push(created.id);
  });

  test("cancel create form", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    const firstColumn = page.locator(".bg-gray-100.rounded-lg").first();
    await firstColumn.locator("button[title='Add issue']").click();

    await expect(page.locator("form")).toBeVisible();

    await page.locator("form").locator('button:has-text("Cancel")').click();

    await expect(page.locator("form")).not.toBeVisible();
  });

  test("open detail panel by clicking issue card", async ({
    page,
    request,
  }) => {
    const suffix = Date.now().toString(36);
    const title = `PanelClickTest ${suffix}`;

    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title,
        description: "Click me",
        priority: "medium",
        statusId,
        projectId,
      },
    });
    const { id } = await createRes.json();
    createdIssueIds.push(id);

    await page.goto("/");
    await page.waitForSelector("h2");

    await page.locator("p", { hasText: title }).first().click();

    await expect(
      page.locator("h2", { hasText: "Issue Details" }),
    ).toBeVisible();
    await expect(
      page.locator("h3", { hasText: title }),
    ).toBeVisible();
    await expect(page.locator(".whitespace-pre-wrap", { hasText: "Click me" })).toBeVisible();
  });

  test("edit issue from detail panel", async ({ page, request }) => {
    const editSuffix = Date.now().toString(36);
    const originalTitle = `EditTest ${editSuffix}`;
    const editedTitle = `EditedTitle ${editSuffix}`;

    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: originalTitle,
        description: "Before edit",
        priority: "low",
        statusId,
        projectId,
      },
    });
    const { id } = await createRes.json();
    createdIssueIds.push(id);

    await page.goto("/");
    await page.waitForSelector("h2");

    await page.locator("p", { hasText: originalTitle }).first().click();
    await expect(
      page.locator("h2", { hasText: "Issue Details" }),
    ).toBeVisible();

    await page.locator('button:has-text("Edit")').click();
    await expect(page.locator("text=Edit Issue")).toBeVisible();

    const panel = page.locator(".fixed.right-0");
    const titleInput = panel.locator('input[type="text"]').first();
    await titleInput.clear();
    await titleInput.fill(editedTitle);

    await page.locator('button:has-text("Save")').click();

    await expect(
      page.locator("h2", { hasText: "Issue Details" }),
    ).not.toBeVisible();

    await expect(
      page.locator("p", { hasText: editedTitle }),
    ).toBeVisible({ timeout: 10000 });
  });

  test("delete issue from detail panel", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const title = `DeleteTestIssue ${suffix}`;

    await request.post(`${SERVER_URL}/api/issues`, {
      data: { title, statusId, projectId },
    });
    // No need to track ID — the test itself deletes it via the UI

    await page.goto("/");
    await page.waitForSelector("h2");

    await page.locator("p", { hasText: title }).first().click();
    await expect(
      page.locator("h2", { hasText: "Issue Details" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Delete issue" }).click();
    await expect(
      page.getByRole("button", { name: "Confirm delete issue" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Confirm delete issue" }).click();

    await expect(
      page.locator("p", { hasText: title }),
    ).not.toBeVisible({ timeout: 5000 });
  });

  test("escape closes detail panel", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const title = `EscapeTestIssue ${suffix}`;

    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title, statusId, projectId },
    });
    const { id } = await createRes.json();
    createdIssueIds.push(id);

    await page.goto("/");
    await page.waitForSelector("h2");

    await page.locator("p", { hasText: title }).first().click();
    await expect(
      page.locator("h2", { hasText: "Issue Details" }),
    ).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(
      page.locator("h2", { hasText: "Issue Details" }),
    ).not.toBeVisible();
  });

  test("drag issue between columns", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const title = `DragTestIssue ${suffix}`;

    const statuses = (
      await (
        await request.get(
          `${SERVER_URL}/api/projects/${projectId}/statuses`,
        )
      ).json()
    );
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    const inProgressStatus = statuses.find((s: { name: string }) => s.name === "In Progress");
    const todoStatusId = todoStatus ? todoStatus.id : statuses[0].id;
    const inProgressStatusId = inProgressStatus ? inProgressStatus.id : statuses[1].id;

    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title, projectId, statusId: todoStatusId },
    });
    const { id: issueId } = await createRes.json();
    createdIssueIds.push(issueId);

    await page.goto("/");
    await page.waitForSelector("h2");

    await page.evaluate(
      ({ iid, srcId, tgtId }) => {
        (window as unknown as Record<string, unknown>).__dragData = {
          issueId: iid,
          sourceStatusId: srcId,
        };

        const columns = document.querySelectorAll(".bg-gray-100.rounded-lg");
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

    await page.waitForTimeout(1000);

    const boardRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/board`,
    );
    const board = await boardRes.json();
    const inProgressColumn = board.find((s: { name: string }) => s.name === "In Progress");
    const movedIssue = inProgressColumn.issues.find(
      (i: { title: string }) => i.title === title,
    );
    expect(movedIssue).toBeDefined();
  });

  test("expand button cycles panel through modal and fullscreen modes", async ({
    page,
    request,
  }) => {
    const suffix = Date.now().toString(36);
    const title = `ExpandTest ${suffix}`;

    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title, statusId, projectId },
    });
    const { id } = await createRes.json();
    createdIssueIds.push(id);

    await page.goto("/");
    await page.waitForSelector("h2");

    // Open detail panel
    await page.locator("p", { hasText: title }).first().click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    // Panel starts in sidebar mode — expand button title should say "Expand to modal"
    const expandBtn = page.locator('button[title="Expand to modal"]');
    await expect(expandBtn).toBeVisible();

    // Click expand: sidebar → modal
    await expandBtn.click();
    await expect(page.locator('button[title="Expand to fullscreen"]')).toBeVisible();

    // Click expand again: modal → fullscreen
    await page.locator('button[title="Expand to fullscreen"]').click();
    await expect(page.locator('button[title="Collapse to sidebar"]')).toBeVisible();

    // Panel should now cover full viewport (inset-0)
    const panel = page.locator("[data-panel]");
    await expect(panel).toHaveClass(/inset-0/);
  });

  test("collapse button returns panel from fullscreen to sidebar", async ({
    page,
    request,
  }) => {
    const suffix = Date.now().toString(36);
    const title = `CollapseTest ${suffix}`;

    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title, statusId, projectId },
    });
    const { id } = await createRes.json();
    createdIssueIds.push(id);

    await page.goto("/");
    await page.waitForSelector("h2");

    // Open detail panel and expand to fullscreen
    await page.locator("p", { hasText: title }).first().click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();
    await page.locator('button[title="Expand to modal"]').click();
    await page.locator('button[title="Expand to fullscreen"]').click();
    await expect(page.locator('button[title="Collapse to sidebar"]')).toBeVisible();

    // Click collapse: fullscreen → sidebar
    await page.locator('button[title="Collapse to sidebar"]').click();

    // Panel should be back in sidebar mode
    await expect(page.locator('button[title="Expand to modal"]')).toBeVisible();
    const panel = page.locator("[data-panel]");
    await expect(panel).not.toHaveClass(/inset-0/);
  });

  test("error banner on API failure", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    await page.route("**/api/issues", (route) => {
      if (route.request().method() === "POST") {
        route.fulfill({ status: 500, body: "Server error" });
      } else {
        route.continue();
      }
    });

    const firstColumn = page.locator(".bg-gray-100.rounded-lg").first();
    await firstColumn.locator("button[title='Add issue']").click();
    const form = page.locator("form");
    await form
      .locator("input[placeholder='Issue title']")
      .fill("Should Fail");
    await form.locator('button:has-text("Add")').click();

    await expect(page.locator("text=Failed to create issue")).toBeVisible();
  });
});
