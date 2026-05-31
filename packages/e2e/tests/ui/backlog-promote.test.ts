import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

test.describe("Backlog promote to Todo", () => {
  let projectId: string;
  let backlogStatusId: string;
  let todoStatusId: string;
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    projectId = await getE2EProjectId(request);

    const statusesRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
    let statuses = await statusesRes.json();

    let backlogStatus = statuses.find((status: { name: string }) => status.name === "Backlog");
    if (!backlogStatus) {
      const backlogRes = await request.post(`${SERVER_URL}/api/projects/${projectId}/statuses`, {
        data: { name: "Backlog", sortOrder: -1 },
      });
      backlogStatus = await backlogRes.json();
      const refreshedStatusesRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
      statuses = await refreshedStatusesRes.json();
    }

    const todoStatus = statuses.find((status: { name: string }) => status.name === "Todo");
    if (!todoStatus) throw new Error("Todo status not found");

    backlogStatusId = backlogStatus.id;
    todoStatusId = todoStatus.id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`).catch(() => undefined);
    }
  });

  test("promotes a backlog issue to Todo without a page reload", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const title = `BacklogPromote ${suffix}`;

    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title, statusId: backlogStatusId, projectId },
    });
    const issue = await createRes.json();
    createdIssueIds.push(issue.id);

    const boardBefore = await (await request.get(`${SERVER_URL}/api/projects/${projectId}/board`)).json();
    const backlogBefore = boardBefore.find((status: { name: string }) => status.name === "Backlog")?.issues.length ?? 0;

    await page.goto("/");
    await page.waitForSelector("h2");
    await page.getByRole("button", { name: "Backlog" }).click();
    await expect(page.getByRole("heading", { name: /Backlog/ })).toBeVisible();
    await expect(page.getByText(title)).toBeVisible();
    await expect(page.getByLabel("Backlog issue count")).toHaveText(String(backlogBefore));

    await page.evaluate(() => {
      (window as unknown as { __backlogPromoteMarker?: string }).__backlogPromoteMarker = "still-here";
    });

    await page.getByRole("button", { name: `Promote issue ${issue.issueNumber} to Todo` }).click();

    await expect(page.getByText(title)).not.toBeVisible();
    await expect(page.getByLabel("Backlog issue count")).toHaveText(String(backlogBefore - 1));
    await expect.poll(() =>
      page.evaluate(() => (window as unknown as { __backlogPromoteMarker?: string }).__backlogPromoteMarker)
    ).toBe("still-here");

    await page.getByRole("button", { name: /Board/ }).click();
    const todoColumn = page.locator(`#column-${todoStatusId}`);
    await expect(todoColumn.getByText(title)).toBeVisible();
  });
});
