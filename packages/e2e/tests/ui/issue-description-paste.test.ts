import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Issue description image paste", () => {
  let projectId: string;
  let statusId: string;
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const activePrefRes = await request.get(`${SERVER_URL}/api/preferences/active-project`);
    const activePref = await activePrefRes.json();
    projectId = activePref.projectId;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todoStatus ? todoStatus.id : statuses[0].id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  test("paste image into description editor shows thumbnail preview", async ({
    page,
    request,
  }) => {
    const suffix = Date.now().toString(36);
    const title = `PasteTest ${suffix}`;

    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title, description: "Initial", priority: "low", statusId, projectId },
    });
    const { id } = await createRes.json();
    createdIssueIds.push(id);

    await page.goto("/");
    await page.waitForSelector("h2");

    // Open issue detail panel
    await page.locator("p", { hasText: title }).first().click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    // Enter edit mode
    await page.locator('button:has-text("Edit")').click();
    await expect(page.locator("text=Edit Issue")).toBeVisible();

    // Locate the description textarea
    const panel = page.locator(".fixed.right-0");
    const textarea = panel.locator("textarea");
    await textarea.click();

    // Build a 1x1 red PNG as a data URL and paste it via clipboardData
    // We use page.evaluate to dispatch a paste event with a fake image file
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==";

    await page.evaluate((url) => {
      const textarea = document.querySelector<HTMLTextAreaElement>(".fixed.right-0 textarea");
      if (!textarea) throw new Error("textarea not found");

      // Create a fake File from the data URL
      const byteString = atob(url.split(",")[1]);
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
      const blob = new Blob([ab], { type: "image/png" });
      const file = new File([blob], "screenshot.png", { type: "image/png" });

      const dt = new DataTransfer();
      dt.items.add(file);

      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
      textarea.dispatchEvent(event);
    }, dataUrl);

    // Thumbnail should appear
    const thumbnail = panel.locator(`img[alt="screenshot-1"]`);
    await expect(thumbnail).toBeVisible({ timeout: 5000 });
    await expect(thumbnail).toHaveAttribute("src", dataUrl);
  });

  test("pasted image thumbnail can be removed via X button", async ({
    page,
    request,
  }) => {
    const suffix = Date.now().toString(36);
    const title = `PasteRemove ${suffix}`;

    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title, description: "Initial", priority: "low", statusId, projectId },
    });
    const { id } = await createRes.json();
    createdIssueIds.push(id);

    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator("p", { hasText: title }).first().click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();
    await page.locator('button:has-text("Edit")').click();

    const panel = page.locator(".fixed.right-0");
    const textarea = panel.locator("textarea");
    await textarea.click();

    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==";

    await page.evaluate((url) => {
      const textarea = document.querySelector<HTMLTextAreaElement>(".fixed.right-0 textarea");
      if (!textarea) throw new Error("textarea not found");
      const byteString = atob(url.split(",")[1]);
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
      const blob = new Blob([ab], { type: "image/png" });
      const file = new File([blob], "screenshot.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      textarea.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
    }, dataUrl);

    const thumbnail = panel.locator(`img[alt="screenshot-1"]`);
    await expect(thumbnail).toBeVisible({ timeout: 5000 });

    // Hover to reveal X button, then click it
    const imageWrapper = panel.locator("div.relative.group").first();
    await imageWrapper.hover();
    const removeButton = imageWrapper.locator("button");
    await removeButton.click();

    await expect(thumbnail).not.toBeVisible();
  });

  test("saving with pasted image includes markdown reference in description", async ({
    page,
    request,
  }) => {
    const suffix = Date.now().toString(36);
    const title = `PasteSave ${suffix}`;
    const baseDescription = "Base description";

    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title, description: baseDescription, priority: "low", statusId, projectId },
    });
    const { id } = await createRes.json();
    createdIssueIds.push(id);

    await page.goto("/");
    await page.waitForSelector("h2");
    await page.locator("p", { hasText: title }).first().click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();
    await page.locator('button:has-text("Edit")').click();

    const panel = page.locator(".fixed.right-0");
    const textarea = panel.locator("textarea");
    await textarea.click();

    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==";

    await page.evaluate((url) => {
      const textarea = document.querySelector<HTMLTextAreaElement>(".fixed.right-0 textarea");
      if (!textarea) throw new Error("textarea not found");
      const byteString = atob(url.split(",")[1]);
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
      const blob = new Blob([ab], { type: "image/png" });
      const file = new File([blob], "screenshot.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      textarea.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
    }, dataUrl);

    await expect(panel.locator(`img[alt="screenshot-1"]`)).toBeVisible({ timeout: 5000 });

    // Save and wait for edit mode to close
    await panel.locator('button:has-text("Save")').click();
    await expect(page.locator("text=Edit Issue")).not.toBeVisible({ timeout: 5000 });

    // Verify saved description contains markdown image reference via API
    const issuesRes = await request.get(`${SERVER_URL}/api/issues?projectId=${projectId}`);
    const issues = await issuesRes.json();
    const issue = issues.find((i: { id: string }) => i.id === id);
    expect(issue).toBeDefined();
    expect(issue.description).toContain(`![screenshot-1](${dataUrl})`);
    expect(issue.description).toContain(baseDescription);
  });
});
