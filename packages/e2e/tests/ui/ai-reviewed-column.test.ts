import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("AI Reviewed column conditional display", () => {
  let projectId: string;
  let todoStatusId: string;
  let aiReviewedStatusId: string;
  let inProgressStatusId: string;
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();
    projectId = projects[0].id;

    // Set this project as active so the board shows it
    await request.put(`${SERVER_URL}/api/preferences/active-project`, {
      data: { projectId },
    });

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    todoStatusId = statuses.find((s: { name: string }) => s.name === "Todo").id;
    aiReviewedStatusId = statuses.find(
      (s: { name: string }) => s.name === "AI Reviewed",
    ).id;
    inProgressStatusId = statuses.find(
      (s: { name: string }) => s.name === "In Progress",
    ).id;

    // Ensure auto_review=true and auto_merge=true so column only shows when issues exist
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { auto_review: "true", auto_merge: "true" },
    });
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
    // Restore defaults
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { auto_review: "true", auto_merge: "true" },
    });
  });

  /** Returns column names from the board columns area only (excludes other h2 on the page). */
  async function getBoardColumnNames(page: import("@playwright/test").Page) {
    const headers = page.locator(".board-columns-scroll h2");
    return (await headers.allTextContents()).map((n) =>
      n.replace(/\s*\d+$/, "").trim(),
    );
  }

  test("AI Reviewed column is hidden when no issues are in that status", async ({
    page,
    request,
  }) => {
    // Move any existing AI Reviewed issues to Todo first
    const boardRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/board`,
    );
    const board = await boardRes.json();
    const aiReviewedCol = board.find(
      (col: { name: string }) => col.name === "AI Reviewed",
    );
    if (aiReviewedCol && aiReviewedCol.issues.length > 0) {
      for (const issue of aiReviewedCol.issues) {
        await request.patch(`${SERVER_URL}/api/issues/${issue.id}`, {
          data: { statusId: todoStatusId },
        });
      }
    }

    await page.goto("/");
    await page.waitForSelector(".board-columns-scroll h2");

    const names = await getBoardColumnNames(page);
    expect(names).not.toContain("AI Reviewed");
  });

  test("AI Reviewed column appears when an issue is moved to that status", async ({
    page,
    request,
  }) => {
    const suffix = Date.now().toString(36);
    const title = `AIReviewedVisibility ${suffix}`;

    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title, projectId, statusId: todoStatusId },
    });
    const { id } = await createRes.json();
    createdIssueIds.push(id);

    // Move to AI Reviewed status
    await request.patch(`${SERVER_URL}/api/issues/${id}`, {
      data: { statusId: aiReviewedStatusId },
    });

    await page.goto("/");
    await page.waitForSelector(".board-columns-scroll h2");

    const names = await getBoardColumnNames(page);
    expect(names).toContain("AI Reviewed");
  });

  test("Awaiting manual merge hint is shown in AI Reviewed column header", async ({
    page,
    request,
  }) => {
    const suffix = Date.now().toString(36);
    const title = `AIReviewedHint ${suffix}`;

    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title, projectId, statusId: aiReviewedStatusId },
    });
    const { id } = await createRes.json();
    createdIssueIds.push(id);

    await page.goto("/");
    await page.waitForSelector(".board-columns-scroll h2");

    await expect(
      page.locator(".board-columns-scroll h2", { hasText: "AI Reviewed" }),
    ).toBeVisible();

    await expect(
      page.locator("span", { hasText: "Awaiting manual merge" }),
    ).toBeVisible();
  });

  test("AI Reviewed column hides again when issue is moved out", async ({
    page,
    request,
  }) => {
    const suffix = Date.now().toString(36);
    const title = `AIReviewedHide ${suffix}`;

    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title, projectId, statusId: aiReviewedStatusId },
    });
    const { id } = await createRes.json();
    createdIssueIds.push(id);

    await page.goto("/");
    await page.waitForSelector(".board-columns-scroll h2");

    // Confirm column is visible with issue in it
    let names = await getBoardColumnNames(page);
    expect(names).toContain("AI Reviewed");

    // Move this issue and all other AI Reviewed issues out so the column hides
    const boardRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/board`,
    );
    const board = await boardRes.json();
    const aiReviewedCol = board.find(
      (col: { name: string }) => col.name === "AI Reviewed",
    );
    if (aiReviewedCol) {
      for (const issue of aiReviewedCol.issues) {
        await request.patch(`${SERVER_URL}/api/issues/${issue.id}`, {
          data: { statusId: inProgressStatusId },
        });
      }
    }

    await page.reload();
    await page.waitForSelector(".board-columns-scroll h2");

    names = await getBoardColumnNames(page);
    expect(names).not.toContain("AI Reviewed");
  });

  test("AI Reviewed column shown when autoReview=true and autoMerge=false regardless of issues", async ({
    page,
    request,
  }) => {
    // Ensure no issues in AI Reviewed
    const boardRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/board`,
    );
    const board = await boardRes.json();
    const aiReviewedCol = board.find(
      (col: { name: string }) => col.name === "AI Reviewed",
    );
    if (aiReviewedCol && aiReviewedCol.issues.length > 0) {
      for (const issue of aiReviewedCol.issues) {
        await request.patch(`${SERVER_URL}/api/issues/${issue.id}`, {
          data: { statusId: todoStatusId },
        });
      }
    }

    // Setting autoMerge=false means column should show even without issues
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { auto_review: "true", auto_merge: "false" },
    });

    await page.goto("/");
    await page.waitForSelector(".board-columns-scroll h2");

    const names = await getBoardColumnNames(page);
    expect(names).toContain("AI Reviewed");

    // Restore
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { auto_review: "true", auto_merge: "true" },
    });
  });
});
