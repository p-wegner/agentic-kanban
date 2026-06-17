import { test, expect, type Page } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

// #203 — markdown Edit/Preview toggle inside the description EDIT mode.
// This is distinct from the view-mode markdown render covered elsewhere; it
// focuses on the in-edit toggle wiring:
//   Source: IssueDetailPanel.tsx (descriptionMode "edit" | "preview")
//     toggle buttons (scoped within the edit form): exact-text "Edit" / "Preview"
//     edit view: <MarkdownToolbar> (buttons with title "Bold"/"Italic"/...) + <textarea>
//     preview view (with content): div.markdown-body rendering ReactMarkdown
//     preview view (empty): <p> "Nothing to preview."
//   Header pencil button aria-label="Edit issue" enters the full edit form;
//   Save header button aria-label="Save issue".
test.describe("Markdown preview toggle (edit mode) UI", () => {
  let projectId: string;
  let statusId: string;
  let suffix: string;
  const createdIssueIds: string[] = [];

  async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    throw new Error(`[${label}] failed after 3 attempts: ${String(lastErr)}`);
  }

  test.beforeAll(async ({ request }) => {
    projectId = await withRetry(() => getE2EProjectId(request), "getE2EProjectId");

    const statuses = await withRetry(async () => {
      const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
      if (!res.ok()) throw new Error(`statuses ${res.status()}`);
      return res.json();
    }, "fetch statuses");
    const todo = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todo ? todo.id : statuses[0].id;

    suffix = Date.now().toString(36);
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  async function openEditForm(page: Page, title: string) {
    await page.goto("/");
    await page.waitForSelector("h2");
    const card = page.locator("p", { hasText: title }).first();
    await expect(card).toBeAttached({ timeout: 20000 });
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible({ timeout: 5000 });
    await card.click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    const panel = page.locator("[data-panel]");
    await panel.getByRole("button", { name: "Edit issue" }).click();
    // Save button only exists in edit mode — confirms the form is open.
    await expect(panel.getByRole("button", { name: "Save issue", exact: true })).toBeVisible();
    return panel;
  }

  test("toolbar shows in Edit, hides in Preview, and content renders in Preview", async ({ page, request }) => {
    test.setTimeout(60000);
    const title = `PreviewToggle ${suffix}`;
    const id = await withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title, description: "## Hello\n\n**strong words**", priority: "medium", statusId, projectId },
      });
      if (!res.ok()) throw new Error(`create issue ${res.status()}`);
      return (await res.json()).id;
    }, "create issue");
    createdIssueIds.push(id);

    const panel = await openEditForm(page, title);

    // The two toggle buttons render only inside the edit form.
    const editTab = panel.getByRole("button", { name: "Edit", exact: true });
    const previewTab = panel.getByRole("button", { name: "Preview", exact: true });
    await expect(editTab).toBeVisible();
    await expect(previewTab).toBeVisible();

    // Edit mode: markdown toolbar (Bold button) + textarea present.
    const boldBtn = panel.locator("button[title='Bold']");
    const textarea = panel.locator("textarea");
    await expect(boldBtn).toBeVisible();
    await expect(textarea).toBeVisible();

    // Switch to Preview: toolbar + textarea disappear, rendered markdown appears.
    await previewTab.click();
    await expect(textarea).not.toBeVisible();
    await expect(boldBtn).not.toBeVisible();

    const markdownBody = panel.locator(".markdown-body").first();
    await expect(markdownBody).toBeVisible();
    await expect(markdownBody.locator("h2")).toHaveText("Hello");
    await expect(markdownBody.locator("strong")).toHaveText("strong words");
    await expect(markdownBody).not.toContainText("## Hello");

    // Back to Edit: toolbar + textarea return.
    await editTab.click();
    await expect(textarea).toBeVisible();
    await expect(boldBtn).toBeVisible();
  });

  test("Preview of an empty description shows the empty-state message", async ({ page, request }) => {
    test.setTimeout(60000);
    const title = `PreviewEmpty ${suffix}`;
    const id = await withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title, priority: "low", statusId, projectId },
      });
      if (!res.ok()) throw new Error(`create issue ${res.status()}`);
      return (await res.json()).id;
    }, "create empty-desc issue");
    createdIssueIds.push(id);

    const panel = await openEditForm(page, title);

    // Ensure the textarea is empty, then preview.
    const textarea = panel.locator("textarea");
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveValue("");

    await panel.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(panel.locator("text=Nothing to preview.")).toBeVisible({ timeout: 5000 });
  });
});
