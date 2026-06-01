import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

interface StatusOption {
  id: string;
  name: string;
  sortOrder: number;
}

test.describe("Board card bulk selection", () => {
  let projectId: string;
  let todoStatus: StatusOption;
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    projectId = await getE2EProjectId(request);

    const statusesRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
    const statuses = ((await statusesRes.json()) as StatusOption[]).sort((a, b) => a.sortOrder - b.sortOrder);
    const todo = statuses.find((status) => status.name === "Todo") ?? statuses.find((status) => status.name !== "Done" && status.name !== "Cancelled");
    if (!todo) throw new Error("No editable board status is available");
    todoStatus = todo;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  test("selects cards with Ctrl-click and applies a bulk priority change", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const titles = [`BulkSelectA ${suffix}`, `BulkSelectB ${suffix}`, `BulkSelectHidden ${suffix}`];

    for (const title of titles) {
      const createRes = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title, priority: "low", statusId: todoStatus.id, projectId },
      });
      const issue = await createRes.json();
      createdIssueIds.push(issue.id);
    }

    await page.addInitScript(() => localStorage.setItem("kanban-board-view", "kanban"));
    await page.goto("/");
    await page.waitForSelector("[data-testid='board-stats-bar']", { timeout: 10000 });

    const cards = titles.map((title) =>
      page.locator("div[draggable]", { has: page.locator("p", { hasText: title }) }).first()
    );
    await expect(cards[0]).toBeVisible({ timeout: 10000 });
    await expect(cards[1]).toBeVisible({ timeout: 10000 });
    await expect(cards[2]).toBeVisible({ timeout: 10000 });

    await cards[0].click({ modifiers: ["Control"] });
    await cards[1].click({ modifiers: ["Control"] });

    await expect(cards[0]).toHaveAttribute("aria-selected", "true");
    await expect(cards[1]).toHaveAttribute("aria-selected", "true");
    const bulkBar = page.getByTestId("board-bulk-action-bar");
    await expect(bulkBar).toContainText("2 selected");

    await bulkBar.getByLabel("Bulk set priority").selectOption("high");

    await expect(bulkBar).toBeHidden({ timeout: 10000 });
    await expect
      .poll(async () => {
        const res = await request.get(`${SERVER_URL}/api/issues?projectId=${projectId}`);
        const issues = await res.json();
        return createdIssueIds.map((id) => issues.find((issue: { id: string; priority: string }) => issue.id === id)?.priority);
      })
      .toEqual(["high", "high", "low"]);

    await cards[0].click({ modifiers: ["Control"] });
    await cards[2].click({ modifiers: ["Control"] });
    await page.locator("#search-input").fill(titles[0]);
    await expect(cards[2]).toBeHidden({ timeout: 10000 });

    await expect(bulkBar).toContainText("1 selected");
    await bulkBar.getByLabel("Bulk set priority").selectOption("critical");

    await expect(bulkBar).toBeHidden({ timeout: 10000 });
    await expect
      .poll(async () => {
        const res = await request.get(`${SERVER_URL}/api/issues?projectId=${projectId}`);
        const issues = await res.json();
        return createdIssueIds.map((id) => issues.find((issue: { id: string; priority: string }) => issue.id === id)?.priority);
      })
      .toEqual(["critical", "high", "low"]);
  });
});
