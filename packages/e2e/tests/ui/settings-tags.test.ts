import { test, expect, type Page } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

const SEED_TAGS = ["bug", "feature", "improvement", "docs"];

async function openTagsTab(page: Page) {
  await page.goto("/");
  await page.waitForSelector("h2");
  await page.locator('button[title="Settings"]').click();
  await expect(page.locator("h2", { hasText: "Settings" })).toBeVisible();
  await page.locator("button", { hasText: "Tags" }).click();
  await expect(page.locator("text=Manage tags used to categorize issues")).toBeVisible();
}

const createdTagIds: string[] = [];

test.describe("Settings Tags tab", () => {
  test("seed tags are visible with color swatches", async ({ page }) => {
    await openTagsTab(page);

    for (const name of SEED_TAGS) {
      const row = page.locator("div.border.border-gray-200.rounded-md", { hasText: name });
      await expect(row).toBeVisible();
      // Color swatch: span with rounded-full style
      await expect(row.locator("span.rounded-full")).toBeVisible();
    }
  });

  test("add a new tag", async ({ page, request }) => {
    const tagName = `e2e-tag-${Date.now().toString(36)}`;
    await openTagsTab(page);

    await page.locator('input[placeholder="Tag name"]').fill(tagName);
    await page.locator("button", { hasText: "Add" }).click();

    await expect(page.locator("text=Tag created")).toBeVisible();
    const row = page.locator("div.border.border-gray-200.rounded-md", { hasText: tagName });
    await expect(row).toBeVisible();

    // Record created tag ID for cleanup
    const tagsRes = await request.get(`${SERVER_URL}/api/tags`);
    const tags = await tagsRes.json();
    const created = tags.find((t: { name: string; id: string }) => t.name === tagName);
    if (created) createdTagIds.push(created.id);
  });

  test("rename an existing tag", async ({ page, request }) => {
    // Create a tag to rename via API so we have a clean starting point
    const originalName = `rename-src-${Date.now().toString(36)}`;
    const renamedName = `renamed-${Date.now().toString(36)}`;
    const createRes = await request.post(`${SERVER_URL}/api/tags`, {
      data: { name: originalName, color: "#3B82F6" },
    });
    const created = await createRes.json();
    createdTagIds.push(created.id);

    await openTagsTab(page);

    const row = page.locator("div.border.border-gray-200.rounded-md", { hasText: originalName });
    await expect(row).toBeVisible();
    await row.locator("button", { hasText: "Rename" }).click();

    const nameInput = row.locator('input[type="text"]');
    await expect(nameInput).toBeVisible();
    await nameInput.fill(renamedName);
    await row.locator("button", { hasText: "Save" }).click();

    await expect(page.locator("text=Tag updated")).toBeVisible();
    await expect(page.locator("div.border.border-gray-200.rounded-md", { hasText: renamedName })).toBeVisible();
    await expect(page.locator("div.border.border-gray-200.rounded-md", { hasText: originalName })).not.toBeVisible();
  });

  test("cancel rename restores original name", async ({ page, request }) => {
    const tagName = `cancel-rename-${Date.now().toString(36)}`;
    const createRes = await request.post(`${SERVER_URL}/api/tags`, {
      data: { name: tagName, color: "#10B981" },
    });
    const created = await createRes.json();
    createdTagIds.push(created.id);

    await openTagsTab(page);

    const row = page.locator("div.border.border-gray-200.rounded-md", { hasText: tagName });
    await row.locator("button", { hasText: "Rename" }).click();
    const nameInput = row.locator('input[type="text"]');
    await nameInput.fill("should-not-save");
    await row.locator("button", { hasText: "Cancel" }).click();

    await expect(row.locator('input[type="text"]')).not.toBeVisible();
    await expect(page.locator("div.border.border-gray-200.rounded-md", { hasText: tagName })).toBeVisible();
  });

  test("delete a tag", async ({ page, request }) => {
    const tagName = `delete-me-${Date.now().toString(36)}`;
    await request.post(`${SERVER_URL}/api/tags`, {
      data: { name: tagName, color: "#EF4444" },
    });

    await openTagsTab(page);

    const row = page.locator("div.border.border-gray-200.rounded-md", { hasText: tagName });
    await expect(row).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await row.locator("button", { hasText: "Delete" }).click();

    await expect(page.locator("text=Tag deleted")).toBeVisible();
    await expect(page.locator("div.border.border-gray-200.rounded-md", { hasText: tagName })).not.toBeVisible();
  });

  test("add tag via Enter key", async ({ page, request }) => {
    const tagName = `enter-tag-${Date.now().toString(36)}`;
    await openTagsTab(page);

    await page.locator('input[placeholder="Tag name"]').fill(tagName);
    await page.locator('input[placeholder="Tag name"]').press("Enter");

    await expect(page.locator("text=Tag created")).toBeVisible();
    await expect(page.locator("div.border.border-gray-200.rounded-md", { hasText: tagName })).toBeVisible();

    const tagsRes = await request.get(`${SERVER_URL}/api/tags`);
    const tags = await tagsRes.json();
    const created = tags.find((t: { name: string; id: string }) => t.name === tagName);
    if (created) createdTagIds.push(created.id);
  });

  test("merge tags combines them into one", async ({ page, request }) => {
    const nameA = `merge-a-${Date.now().toString(36)}`;
    const nameB = `merge-b-${Date.now().toString(36)}`;

    const resA = await request.post(`${SERVER_URL}/api/tags`, {
      data: { name: nameA, color: "#6B7280" },
    });
    const resB = await request.post(`${SERVER_URL}/api/tags`, {
      data: { name: nameB, color: "#6B7280" },
    });
    const tagA = await resA.json();
    const tagB = await resB.json();
    createdTagIds.push(tagA.id);
    // tagB will be deleted by the merge — don't add to cleanup list

    await openTagsTab(page);

    // Select both tags via checkboxes
    const rowA = page.locator("div.border.border-gray-200.rounded-md", { hasText: nameA });
    const rowB = page.locator("div.border.border-gray-200.rounded-md", { hasText: nameB });
    await rowA.locator('input[type="checkbox"]').check();
    await rowB.locator('input[type="checkbox"]').check();

    // Merge section should appear
    await expect(page.locator("text=Merge selected tags")).toBeVisible();

    // Select tagA as the merge target
    await page.locator("select").selectOption({ value: tagA.id });
    await page.locator("button", { hasText: "Merge" }).click();

    await expect(page.locator("text=Tags merged")).toBeVisible();
    // Source tag (B) is deleted, target (A) remains
    await expect(page.locator("div.border.border-gray-200.rounded-md", { hasText: nameA })).toBeVisible();
    await expect(page.locator("div.border.border-gray-200.rounded-md", { hasText: nameB })).not.toBeVisible();
  });

  test("edit tag color is saved", async ({ page, request }) => {
    const tagName = `color-tag-${Date.now().toString(36)}`;
    const createRes = await request.post(`${SERVER_URL}/api/tags`, {
      data: { name: tagName, color: "#3B82F6" },
    });
    const created = await createRes.json();
    createdTagIds.push(created.id);

    await openTagsTab(page);

    const row = page.locator("div.border.border-gray-200.rounded-md", { hasText: tagName });
    await row.locator("button", { hasText: "Rename" }).click();

    // Change color via color picker
    const colorInput = row.locator('input[type="color"]');
    await expect(colorInput).toBeVisible();
    await colorInput.fill("#EF4444");
    await row.locator("button", { hasText: "Save" }).click();

    await expect(page.locator("text=Tag updated")).toBeVisible();

    // Verify color was persisted via API
    const tagsRes = await request.get(`${SERVER_URL}/api/tags`);
    const tags = await tagsRes.json();
    const updated = tags.find((t: { id: string }) => t.id === created.id);
    expect(updated?.color).toBe("#EF4444");
  });
});

test.afterAll(async ({ request }) => {
  for (const id of createdTagIds) {
    await request.delete(`${SERVER_URL}/api/tags/${id}`).catch(() => {});
  }
});
