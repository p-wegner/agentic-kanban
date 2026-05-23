import { test, expect, APIRequestContext } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

async function withRetry<T>(fn: () => Promise<T>, attempts = 5, delayMs = 1500): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
    try {
      return await fn();
    } catch {
      if (i === attempts - 1) throw new Error(`Failed after ${attempts} attempts`);
    }
  }
  throw new Error("unreachable");
}

async function createIssue(
  request: APIRequestContext,
  data: { title: string; description: string; priority: string; statusId: string; projectId: string }
): Promise<string> {
  return withRetry(async () => {
    const res = await request.post(`${SERVER_URL}/api/issues`, { data });
    if (res.status() !== 201) throw new Error(`status ${res.status()}`);
    const { id } = await res.json();
    return id;
  });
}

const MARKDOWN_DESCRIPTION = `# Heading One

## Heading Two

This is **bold text** and this is *italic text*.

- Item one
- Item two
- Item three

1. First item
2. Second item

\`inline code\`

\`\`\`
code block line one
code block line two
\`\`\`
`;

test.describe("Issue description markdown rendering", () => {
  let projectId: string;
  let statusId: string;
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    await withRetry(async () => {
      const activePrefRes = await request.get(`${SERVER_URL}/api/preferences/active-project`);
      const activePref = await activePrefRes.json();
      projectId = activePref.projectId;
    });

    await withRetry(async () => {
      const statusesRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
      const statuses = await statusesRes.json();
      const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
      statusId = todoStatus ? todoStatus.id : statuses[0].id;
    });
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
        try {
          await request.delete(`${SERVER_URL}/api/issues/${id}`);
          break;
        } catch {
          // retry
        }
      }
    }
  });

  test("description with markdown renders as HTML in detail panel", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const title = `MarkdownRender ${suffix}`;

    const id = await createIssue(request, { title, description: MARKDOWN_DESCRIPTION, priority: "medium", statusId, projectId });
    createdIssueIds.push(id);

    await withRetry(() => request.put(`${SERVER_URL}/api/preferences/active-project`, { data: { projectId } }));
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const issueCard1 = page.locator("p", { hasText: title }).first();
    await expect(issueCard1).toBeVisible({ timeout: 15000 });
    await issueCard1.dispatchEvent("click");
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    const panel = page.locator(".fixed.right-0");
    const markdownBody = panel.locator(".markdown-body");
    await expect(markdownBody).toBeVisible();

    // Headings render as h1/h2 elements, not raw "# Heading" text
    await expect(markdownBody.locator("h1")).toBeVisible();
    await expect(markdownBody.locator("h1")).toHaveText("Heading One");
    await expect(markdownBody.locator("h2")).toBeVisible();
    await expect(markdownBody.locator("h2")).toHaveText("Heading Two");

    // Bold text renders as <strong>
    await expect(markdownBody.locator("strong")).toHaveText("bold text");

    // Unordered list renders as <ul><li>
    const ul = markdownBody.locator("ul");
    await expect(ul).toBeVisible();
    await expect(ul.locator("li").first()).toHaveText("Item one");

    // Ordered list renders as <ol><li>
    const ol = markdownBody.locator("ol");
    await expect(ol).toBeVisible();
    await expect(ol.locator("li").first()).toHaveText("First item");

    // Inline code renders as <code>
    await expect(markdownBody.locator("code").first()).toHaveText("inline code");

    // Code block renders as <pre><code>
    await expect(markdownBody.locator("pre")).toBeVisible();

    // Raw markdown syntax must NOT appear as literal text
    await expect(markdownBody).not.toContainText("# Heading One");
    await expect(markdownBody).not.toContainText("**bold text**");
    await expect(markdownBody).not.toContainText("- Item one");
  });

  test("edit mode shows raw markdown in textarea", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const title = `MarkdownEdit ${suffix}`;

    const id = await createIssue(request, { title, description: MARKDOWN_DESCRIPTION, priority: "low", statusId, projectId });
    createdIssueIds.push(id);

    await withRetry(() => request.put(`${SERVER_URL}/api/preferences/active-project`, { data: { projectId } }));
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const issueCard2 = page.locator("p", { hasText: title }).first();
    await expect(issueCard2).toBeVisible({ timeout: 15000 });
    await issueCard2.dispatchEvent("click");
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    // Enter edit mode
    await page.locator('button:has-text("Edit")').click();
    await expect(page.locator("text=Edit Issue")).toBeVisible();

    const panel = page.locator(".fixed.right-0");
    const textarea = panel.locator("textarea");
    await expect(textarea).toBeVisible();

    // Textarea contains raw markdown, not rendered HTML
    const value = await textarea.inputValue();
    expect(value).toContain("# Heading One");
    expect(value).toContain("**bold text**");
    expect(value).toContain("- Item one");
    expect(value).toContain("`inline code`");
  });

  test("edit description, save, and re-renders updated markdown", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const title = `MarkdownUpdate ${suffix}`;

    const id = await createIssue(request, { title, description: "Original description", priority: "low", statusId, projectId });
    createdIssueIds.push(id);

    await withRetry(() => request.put(`${SERVER_URL}/api/preferences/active-project`, { data: { projectId } }));
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const issueCard3 = page.locator("p", { hasText: title }).first();
    await expect(issueCard3).toBeVisible({ timeout: 15000 });
    await issueCard3.dispatchEvent("click");
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    await page.locator('button:has-text("Edit")').click();
    await expect(page.locator("text=Edit Issue")).toBeVisible();

    const panel = page.locator(".fixed.right-0");
    const textarea = panel.locator("textarea");
    await textarea.fill("## Updated Heading\n\n**Updated bold**\n\n- list item");

    await panel.locator('button:has-text("Save")').click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible({ timeout: 10000 });

    // After save, description renders as HTML
    const markdownBody = panel.locator(".markdown-body");
    await expect(markdownBody.locator("h2")).toHaveText("Updated Heading");
    await expect(markdownBody.locator("strong")).toHaveText("Updated bold");
    await expect(markdownBody.locator("ul li").first()).toHaveText("list item");

    // Raw syntax must not be visible
    await expect(markdownBody).not.toContainText("## Updated Heading");
    await expect(markdownBody).not.toContainText("**Updated bold**");
  });
});
