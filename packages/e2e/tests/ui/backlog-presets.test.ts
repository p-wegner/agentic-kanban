import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

test.describe("Backlog filter presets", () => {
  let projectId: string;
  let backlogStatusId: string;
  let suffix: string;
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
    backlogStatusId = backlogStatus.id;
    suffix = Date.now().toString(36);

    for (const data of [
      {
        title: `PresetBug ${suffix}`,
        description: `Search target ${suffix}`,
        priority: "high",
        issueType: "bug",
      },
      {
        title: `PresetFeature ${suffix}`,
        description: "Competing backlog item",
        priority: "low",
        issueType: "feature",
      },
    ]) {
      const res = await request.post(`${SERVER_URL}/api/issues`, {
        data: { ...data, statusId: backlogStatusId, projectId },
      });
      createdIssueIds.push((await res.json()).id);
    }

    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { [`backlog_filter_presets_${projectId}`]: "[]" },
    });
  });

  test.afterAll(async ({ request }) => {
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { [`backlog_filter_presets_${projectId}`]: "[]" },
    }).catch(() => undefined);
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`).catch(() => undefined);
    }
  });

  test("saves, applies, and deletes a backlog preset", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator("button", { hasText: "Backlog" }).click();
    await expect(page.locator("h2", { hasText: "Backlog" })).toBeVisible();

    await page.getByPlaceholder('Search issues... ("/")').fill(`PresetBug ${suffix}`);
    await page.locator("label", { hasText: "Sort" }).locator("select").selectOption("priority");
    await page.locator("label", { hasText: "Group" }).locator("select").selectOption("type");
    await page.getByLabel("Backlog preset name").fill(`High bugs ${suffix}`);
    await page.getByRole("button", { name: "Save backlog preset" }).click();

    const presetSelect = page.getByLabel("Backlog preset", { exact: true });
    await expect(presetSelect).toContainText(`High bugs ${suffix}`);

    await page.getByPlaceholder('Search issues... ("/")').fill(`PresetFeature ${suffix}`);
    await page.locator("label", { hasText: "Sort" }).locator("select").selectOption("oldest");
    await page.locator("label", { hasText: "Group" }).locator("select").selectOption("none");
    await expect(page.getByText(`PresetFeature ${suffix}`).first()).toBeVisible();
    await expect(page.getByText(`PresetBug ${suffix}`)).not.toBeVisible();

    await presetSelect.selectOption({ label: `High bugs ${suffix}` });
    await page.locator("button", { hasText: "Apply" }).click();

    await expect(page.getByPlaceholder('Search issues... ("/")')).toHaveValue(`PresetBug ${suffix}`);
    await expect(page.locator("label", { hasText: "Sort" }).locator("select")).toHaveValue("priority");
    await expect(page.locator("label", { hasText: "Group" }).locator("select")).toHaveValue("type");
    await expect(page.locator("h3", { hasText: "Bug" })).toBeVisible();
    await expect(page.getByText(`PresetBug ${suffix}`).first()).toBeVisible();
    await expect(page.getByText(`PresetFeature ${suffix}`)).not.toBeVisible();

    await page.locator("button", { hasText: "Delete" }).click();
    await expect(presetSelect).not.toContainText(`High bugs ${suffix}`);
  });
});
