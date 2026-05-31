import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

interface StatusOption {
  id: string;
  name: string;
  sortOrder: number;
}

test.describe("Issue card context menu", () => {
  let projectId: string;
  let sourceStatus: StatusOption;
  let nextStatus: StatusOption;
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    projectId = await getE2EProjectId(request);

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = ((await statusesRes.json()) as StatusOption[]).sort(
      (a, b) => a.sortOrder - b.sortOrder,
    );
    const sourceIndex = statuses.findIndex(
      (status, index) => status.name === "Todo" && index < statuses.length - 1,
    );

    if (sourceIndex < 0) {
      throw new Error("No Todo status with a next status is available");
    }

    sourceStatus = statuses[sourceIndex];
    nextStatus = statuses[sourceIndex + 1];
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  test("opens from right-click and copies issue reference", async ({
    page,
    context,
    request,
  }) => {
    const suffix = Date.now().toString(36);
    const title = `ContextCopy ${suffix}`;

    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title, priority: "low", statusId: sourceStatus.id, projectId },
    });
    const issue = await createRes.json();
    createdIssueIds.push(issue.id);

    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    await page.goto("/");
    await page.waitForSelector("[data-testid='board-stats-bar']", {
      timeout: 10000,
    });

    const card = page
      .locator("div[draggable]", { has: page.locator("p", { hasText: title }) })
      .first();
    await expect(card).toBeVisible({ timeout: 10000 });

    await card.click({ button: "right" });
    const menu = page.getByRole("menu", { name: new RegExp(title) });
    await expect(menu).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Copy issue reference" }),
    ).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    await card.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Copy issue reference" }).click();

    await expect(menu).toBeHidden();
    await expect(page.getByText("Issue reference copied")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`#${issue.issueNumber} ${title}`);
  });

  test("invokes the existing move-to-next-status action", async ({
    page,
    request,
  }) => {
    const suffix = Date.now().toString(36);
    const title = `ContextMove ${suffix}`;

    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title, priority: "medium", statusId: sourceStatus.id, projectId },
    });
    const issue = await createRes.json();
    createdIssueIds.push(issue.id);

    await page.goto("/");
    await page.waitForSelector("[data-testid='board-stats-bar']", {
      timeout: 10000,
    });

    const card = page
      .locator("div[draggable]", { has: page.locator("p", { hasText: title }) })
      .first();
    await expect(card).toBeVisible({ timeout: 10000 });

    await card.click({ button: "right" });
    const menu = page.getByRole("menu", { name: new RegExp(title) });
    await expect(menu).toBeVisible();
    await menu
      .getByRole("menuitem", { name: `Move to ${nextStatus.name}` })
      .click();

    await expect(menu).toBeHidden();
    await expect
      .poll(async () => {
        const res = await request.get(
          `${SERVER_URL}/api/issues?projectId=${projectId}`,
        );
        const issues = await res.json();
        return issues.find(
          (candidate: { id: string; statusId: string }) =>
            candidate.id === issue.id,
        )?.statusId;
      })
      .toBe(nextStatus.id);
  });
});
