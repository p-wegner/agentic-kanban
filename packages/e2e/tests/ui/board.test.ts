import { test, expect, type APIRequestContext } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

type BoardIssue = {
  id: string;
  title: string;
};

type BoardColumn = {
  name: string;
  issues: BoardIssue[];
};

async function findIssueColumn(
  request: APIRequestContext,
  projectId: string,
  title: string,
): Promise<string | null> {
  const boardRes = await request.get(
    `${SERVER_URL}/api/projects/${projectId}/board`,
  );
  const board: BoardColumn[] = await boardRes.json();
  const column = board.find((status) =>
    status.issues.some((issue) => issue.title === title),
  );
  return column?.name ?? null;
}

async function waitForIssueInColumn(
  request: APIRequestContext,
  projectId: string,
  title: string,
  expectedColumn: string,
) {
  let currentColumn: string | null = null;
  let lastReadError: unknown = null;

  try {
    await expect
      .poll(
        async () => {
          try {
            currentColumn = await findIssueColumn(request, projectId, title);
            lastReadError = null;
          } catch (error) {
            lastReadError = error;
          }
          return currentColumn;
        },
        {
          intervals: [100, 250, 500, 1000],
          timeout: 10000,
          message: `Wait for issue "${title}" to appear in "${expectedColumn}"`,
        },
      )
      .toBe(expectedColumn);
  } catch (error) {
    currentColumn = await findIssueColumn(request, projectId, title).catch(
      () => currentColumn,
    );
    const readErrorMessage =
      lastReadError instanceof Error
        ? `Last board read error: ${lastReadError.message}\n`
        : "";
    throw new Error(
      `Timed out waiting for issue "${title}" to move to "${expectedColumn}". Current column: ${currentColumn ?? "not found"}.\n${readErrorMessage}${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

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

  test("edit issue from detail panel", async ({ page, request }, testInfo) => {
    const editSuffix = [
      Date.now().toString(36),
      testInfo.workerIndex,
      testInfo.repeatEachIndex,
      Math.random().toString(36).slice(2, 8),
    ].join("-");
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

    await page.getByLabel(`Open issue ${originalTitle}`).click();

    const panel = page.locator("[data-panel]").filter({
      has: page.getByRole("heading", { name: "Issue Details" }),
    });
    await expect(panel).toBeVisible();
    await expect(
      panel.getByRole("heading", { name: originalTitle }),
    ).toBeVisible();

    await panel.getByRole("button", { name: "Edit issue" }).click();
    const titleInput = panel.getByLabel("Issue title");
    await expect(titleInput).toBeEditable();
    await titleInput.fill(editedTitle);

    await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes(`/api/issues/${id}`)
        && response.request().method() === "PATCH"
        && response.ok(),
      ),
      panel.getByRole("button", { name: "Save issue", exact: true }).click(),
    ]);

    await expect(titleInput).not.toBeVisible({ timeout: 15000 });
    await expect(panel.getByRole("button", { name: "Edit issue" })).toBeVisible();
    await expect(
      panel.getByRole("heading", { name: editedTitle }),
    ).toBeVisible();

    await expect(
      page.getByLabel(`Open issue ${editedTitle}`),
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

        const targetCol = document.getElementById(`column-${tgtId}`);
        if (!targetCol) throw new Error(`In Progress column ${tgtId} not found`);

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

    await waitForIssueInColumn(request, projectId, title, "In Progress");
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
