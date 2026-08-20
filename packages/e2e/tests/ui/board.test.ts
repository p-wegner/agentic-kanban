import { test, expect, type APIRequestContext } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";
import { boardColumn, completedToggle, issueCard, narrowBoardTo } from "../helpers/board-ui.js";

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

    // Assert on the columns' declared identity, not on every <h2> in the document: the old
    // version scraped all h2 text and stripped a trailing count with a regex, so any other
    // heading on the page (the detail panel's own "Issue Details") joined the column list.
    await expect(boardColumn(page, "Todo")).toBeVisible();
    await expect(boardColumn(page, "In Progress")).toBeVisible();
    await expect(boardColumn(page, "In Review")).toBeVisible();

    // Done and Cancelled are NOT columns any more — they are folded into the Completed
    // group, which renders a card grid behind a collapse bar. The old assertion looked for
    // them as <h2> column headings, i.e. it described a UI that no longer exists. The bar
    // itself is absent when nothing is completed, so this only asserts the shape when there
    // is something to show.
    const toggle = completedToggle(page);
    if (await toggle.count()) {
      await expect(toggle).toContainText("Completed");
      await toggle.click();
      await expect(page.locator("[data-testid='completed-grid']")).toBeVisible();
    }
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
    await narrowBoardTo(page, suffix);

    const firstColumn = boardColumn(page, "Todo");
    await firstColumn.locator("button[title='Add issue']").click();

    // Three separate drifts had accumulated here, none of them visible from the old locators:
    // the title is a <textarea> (not an <input>), the description placeholder gained a
    // "— paste screenshots with Ctrl+V" suffix that an exact `[placeholder=…]` match cannot
    // see, and the form has no PRIORITY select at all any more — `form.locator("select")`
    // now resolves to the issue-type and estimate selects, so `selectOption("high")` was
    // setting a control that does not exist.
    const form = page.locator("[data-testid='create-issue-form']");
    await form.locator("[data-testid='create-issue-title']").fill(title);
    await form.locator("[data-testid='create-issue-description']").fill("Created by e2e test");
    await form.locator("[data-testid='create-issue-submit']").click();

    await expect(
      issueCard(page, title),
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

    const firstColumn = boardColumn(page, "Todo");
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
    await narrowBoardTo(page, suffix);

    await issueCard(page, title).click();

    await expect(
      page.locator("h2", { hasText: "Issue Details" }),
    ).toBeVisible();
    await expect(
      page.locator("h3", { hasText: title }),
    ).toBeVisible();
    // The description renders as MARKDOWN now (`.markdown-body`), not preformatted text, so
    // the old `.whitespace-pre-wrap` class chain matched nothing.
    await expect(page.locator("[data-testid='issue-description']")).toContainText("Click me");
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
    await narrowBoardTo(page, editSuffix);

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
    await narrowBoardTo(page, suffix);

    await issueCard(page, title).click();
    await expect(
      page.locator("h2", { hasText: "Issue Details" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Delete issue" }).click();
    await expect(
      page.getByRole("button", { name: "Confirm delete issue" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Confirm delete issue" }).click();

    await expect(
      issueCard(page, title),
    ).toHaveCount(0, { timeout: 5000 });
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
    await narrowBoardTo(page, suffix);

    await issueCard(page, title).click();
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
    await narrowBoardTo(page, suffix);

    // Precondition: the card starts rendered in Todo.
    const cardInTodo = page
      .locator(`#column-${todoStatusId}`)
      .getByLabel(`Open issue ${title}`);
    await expect(cardInTodo).toBeVisible({ timeout: 10000 });

    // Drive a real drag: fire `dragstart` on the card so the app's onDragStart
    // handler populates its module-level drag payload (the board no longer reads
    // a `window.__dragData` global), then dispatch `drop` on the target column.
    await page.evaluate(
      ({ cardLabel, tgtId }) => {
        const card = document.querySelector<HTMLElement>(
          `[aria-label="Open issue ${cardLabel}"]`,
        );
        if (!card) throw new Error(`card "${cardLabel}" not found`);
        const targetCol = document.getElementById(`column-${tgtId}`);
        if (!targetCol) throw new Error(`In Progress column ${tgtId} not found`);

        const startEvent = new DragEvent("dragstart", { bubbles: true, cancelable: true });
        Object.defineProperty(startEvent, "dataTransfer", { value: new DataTransfer() });
        card.dispatchEvent(startEvent);

        const dropEvent = new DragEvent("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(dropEvent, "dataTransfer", { value: new DataTransfer() });
        targetCol.dispatchEvent(dropEvent);
      },
      { cardLabel: title, tgtId: inProgressStatusId },
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
    await narrowBoardTo(page, suffix);

    // Open detail panel
    await issueCard(page, title).click();
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
    await narrowBoardTo(page, suffix);

    // Open detail panel and expand to fullscreen
    await issueCard(page, title).click();
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

    const firstColumn = boardColumn(page, "Todo");
    await firstColumn.locator("button[title='Add issue']").click();
    const form = page.locator("[data-testid='create-issue-form']");
    await form.locator("[data-testid='create-issue-title']").fill("Should Fail");
    await form.locator("[data-testid='create-issue-submit']").click();

    await expect(page.locator("text=Failed to create issue")).toBeVisible();
  });
});
