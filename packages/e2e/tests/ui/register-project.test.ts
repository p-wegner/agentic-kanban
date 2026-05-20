import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

const VALID_REPO_PATH = "C:/andrena/agentic-kanban";

async function openModal(page: import("@playwright/test").Page) {
  await page.locator('button[title="Register project"]').click();
  await expect(page.locator("h2", { hasText: "Add Project" })).toBeVisible();
}

test.describe("Register Project UI", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h1");
  });

  test("register button is visible in header", async ({ page }) => {
    const registerBtn = page.locator('button[title="Register project"]');
    await expect(registerBtn).toBeVisible();
  });

  test("clicking register button opens modal with two tabs", async ({ page }) => {
    await openModal(page);
    await expect(page.locator("button", { hasText: "Import existing" })).toBeVisible();
    await expect(page.locator("button", { hasText: "Create new" })).toBeVisible();
  });

  test("Import existing tab shows repo path input by default", async ({ page }) => {
    await openModal(page);
    await expect(page.locator('input[placeholder="C:/path/to/repo"]')).toBeVisible();
    await expect(page.locator("text=Absolute path to a git repository")).toBeVisible();
  });

  test("Register button is disabled when path is empty", async ({ page }) => {
    await openModal(page);
    const submitBtn = page.locator('button[type="submit"]', { hasText: /Register/ });
    await expect(submitBtn).toBeDisabled();
  });

  test("Register button enables when path is entered", async ({ page }) => {
    await openModal(page);
    await page.locator('input[placeholder="C:/path/to/repo"]').fill("/some/path");
    const submitBtn = page.locator('button[type="submit"]', { hasText: /Register/ });
    await expect(submitBtn).toBeEnabled();
  });

  test("Cancel button closes the modal", async ({ page }) => {
    await openModal(page);
    await page.locator("button", { hasText: /^Cancel$/ }).click();
    await expect(page.locator("h2", { hasText: "Add Project" })).not.toBeVisible();
  });

  test("clicking backdrop closes the modal", async ({ page }) => {
    await openModal(page);
    await page.locator(".fixed.inset-0.bg-black\\/40").click({ position: { x: 10, y: 10 } });
    await expect(page.locator("h2", { hasText: "Add Project" })).not.toBeVisible();
  });

  test("modal clears input when reopened", async ({ page }) => {
    await openModal(page);
    await page.locator('input[placeholder="C:/path/to/repo"]').fill("/some/path");
    await page.locator("button", { hasText: /^Cancel$/ }).click();

    await openModal(page);
    await expect(page.locator('input[placeholder="C:/path/to/repo"]')).toHaveValue("");
  });

  test("invalid path (not a git repo) shows error", async ({ page }) => {
    await openModal(page);
    await page.locator('input[placeholder="C:/path/to/repo"]').fill("C:/nonexistent/path/xyz");
    await page.locator('button[type="submit"]', { hasText: /Register/ }).click();

    await expect(page.locator("p.text-red-600")).toBeVisible();
    // Modal stays open on error
    await expect(page.locator("h2", { hasText: "Add Project" })).toBeVisible();
  });

  test("duplicate path shows error message", async ({ page }) => {
    await page.route("**/api/projects", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: 'Project "agentic-kanban" is already registered at this path' }),
        });
      } else {
        await route.continue();
      }
    });

    await openModal(page);
    await page.locator('input[placeholder="C:/path/to/repo"]').fill(VALID_REPO_PATH);
    await page.locator('button[type="submit"]', { hasText: /Register/ }).click();

    await expect(page.locator("p.text-red-600")).toBeVisible();
    await expect(page.locator("p.text-red-600")).toContainText("already registered");
    await expect(page.locator("h2", { hasText: "Add Project" })).toBeVisible();
  });

  test("server error is displayed", async ({ page }) => {
    await page.route("**/api/projects", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "Invalid repo: not a git repository" }),
        });
      } else {
        await route.continue();
      }
    });

    await openModal(page);
    await page.locator('input[placeholder="C:/path/to/repo"]').fill("/not/a/git/repo");
    await page.locator('button[type="submit"]', { hasText: /Register/ }).click();

    await expect(page.locator("p.text-red-600")).toBeVisible();
    await expect(page.locator("p.text-red-600")).toContainText("not a git repository");
  });

  test("successful registration closes modal and sends correct path", async ({ page }) => {
    let capturedBody: { repoPath?: string } = {};
    await page.route("**/api/projects", async (route) => {
      if (route.request().method() === "POST") {
        capturedBody = route.request().postDataJSON();
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ id: "test-id", name: "test-repo", repoPath: capturedBody.repoPath }),
        });
      } else {
        await route.continue();
      }
    });

    await openModal(page);
    await page.locator('input[placeholder="C:/path/to/repo"]').fill("/some/repo/path");
    await page.locator('button[type="submit"]', { hasText: /Register/ }).click();

    await expect(page.locator("h2", { hasText: "Add Project" })).not.toBeVisible();
    expect(capturedBody.repoPath).toBe("/some/repo/path");
  });

  test("shows Registering… label while submitting", async ({ page }) => {
    await page.route("**/api/projects", async (route) => {
      if (route.request().method() === "POST") {
        await new Promise((r) => setTimeout(r, 300));
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ id: "test-id", name: "test-repo", repoPath: "/some/repo" }),
        });
      } else {
        await route.continue();
      }
    });

    await openModal(page);
    await page.locator('input[placeholder="C:/path/to/repo"]').fill("/some/repo");
    await page.locator('button[type="submit"]', { hasText: /Register/ }).click();

    await expect(page.locator('button[type="submit"]', { hasText: "Registering…" })).toBeVisible();
  });
});

test.describe("Create Project UI", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h1");
  });

  async function openCreateTab(page: import("@playwright/test").Page) {
    await page.locator('button[title="Register project"]').click();
    await expect(page.locator("h2", { hasText: "Add Project" })).toBeVisible();
    await page.locator("button", { hasText: "Create new" }).click();
  }

  test("switching to Create new tab shows project name input", async ({ page }) => {
    await openCreateTab(page);
    await expect(page.locator('input[placeholder="my-project"]')).toBeVisible();
    await expect(page.locator('input[placeholder="Defaults to projects base directory / name"]')).toBeVisible();
  });

  test("Create project button is disabled when name is empty", async ({ page }) => {
    await openCreateTab(page);
    const submitBtn = page.locator('button[type="submit"]', { hasText: /Create project/ });
    await expect(submitBtn).toBeDisabled();
  });

  test("Create project button enables when name is entered", async ({ page }) => {
    await openCreateTab(page);
    await page.locator('input[placeholder="my-project"]').fill("my-new-project");
    const submitBtn = page.locator('button[type="submit"]', { hasText: /Create project/ });
    await expect(submitBtn).toBeEnabled();
  });

  test("path field is optional", async ({ page }) => {
    await openCreateTab(page);
    await page.locator('input[placeholder="my-project"]').fill("my-new-project");
    // Path is empty — button should still be enabled
    const submitBtn = page.locator('button[type="submit"]', { hasText: /Create project/ });
    await expect(submitBtn).toBeEnabled();
  });

  test(".gitignore template dropdown has expected options", async ({ page }) => {
    await openCreateTab(page);
    const select = page.locator("select").first();
    await expect(select.locator("option", { hasText: "None" })).toBeAttached();
    await expect(select.locator("option", { hasText: "Node" })).toBeAttached();
    await expect(select.locator("option", { hasText: "Python" })).toBeAttached();
    await expect(select.locator("option", { hasText: "Go" })).toBeAttached();
  });

  test("Generate README checkbox is unchecked by default", async ({ page }) => {
    await openCreateTab(page);
    const checkbox = page.locator("label", { hasText: "Generate README.md" }).locator("input[type='checkbox']");
    await expect(checkbox).not.toBeChecked();
  });

  test("Generate README checkbox can be toggled", async ({ page }) => {
    await openCreateTab(page);
    const checkbox = page.locator("label", { hasText: "Generate README.md" }).locator("input[type='checkbox']");
    await checkbox.check();
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();
  });

  test("Cancel button closes the modal from Create tab", async ({ page }) => {
    await openCreateTab(page);
    await page.locator("button", { hasText: /^Cancel$/ }).click();
    await expect(page.locator("h2", { hasText: "Add Project" })).not.toBeVisible();
  });

  test("server error is displayed on Create tab", async ({ page }) => {
    await page.route("**/api/projects/create", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Failed to initialize git repository" }),
        });
      } else {
        await route.continue();
      }
    });

    await openCreateTab(page);
    await page.locator('input[placeholder="my-project"]').fill("my-new-project");
    await page.locator('button[type="submit"]', { hasText: /Create project/ }).click();

    await expect(page.locator("p.text-red-600")).toBeVisible();
    await expect(page.locator("p.text-red-600")).toContainText("Failed to initialize git repository");
    await expect(page.locator("h2", { hasText: "Add Project" })).toBeVisible();
  });

  test("successful creation closes modal and sends correct data", async ({ page }) => {
    let capturedBody: Record<string, unknown> = {};
    await page.route("**/api/projects/create", async (route) => {
      if (route.request().method() === "POST") {
        capturedBody = route.request().postDataJSON();
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ id: "new-id", name: "my-new-project" }),
        });
      } else {
        await route.continue();
      }
    });

    await openCreateTab(page);
    await page.locator('input[placeholder="my-project"]').fill("my-new-project");
    await page.locator('input[placeholder="Defaults to projects base directory / name"]').fill("/custom/path");
    await page.locator('button[type="submit"]', { hasText: /Create project/ }).click();

    await expect(page.locator("h2", { hasText: "Add Project" })).not.toBeVisible();
    expect(capturedBody.name).toBe("my-new-project");
    expect(capturedBody.path).toBe("/custom/path");
  });

  test("shows Creating… label while submitting", async ({ page }) => {
    await page.route("**/api/projects/create", async (route) => {
      if (route.request().method() === "POST") {
        await new Promise((r) => setTimeout(r, 300));
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ id: "new-id", name: "my-new-project" }),
        });
      } else {
        await route.continue();
      }
    });

    await openCreateTab(page);
    await page.locator('input[placeholder="my-project"]').fill("my-new-project");
    await page.locator('button[type="submit"]', { hasText: /Create project/ }).click();

    await expect(page.locator('button[type="submit"]', { hasText: "Creating…" })).toBeVisible();
  });

  test("switching tabs resets errors from previous tab", async ({ page }) => {
    await page.route("**/api/projects", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "Some error" }),
        });
      } else {
        await route.continue();
      }
    });

    // Trigger an error on the Import tab
    await page.locator('button[title="Register project"]').click();
    await page.locator('input[placeholder="C:/path/to/repo"]').fill("/bad/path");
    await page.locator('button[type="submit"]', { hasText: /Register/ }).click();
    await expect(page.locator("p.text-red-600")).toBeVisible();

    // Switch to Create tab — error from Import tab should not be visible
    await page.locator("button", { hasText: "Create new" }).click();
    await expect(page.locator("p.text-red-600")).not.toBeVisible();
  });

  test("modal resets to Import tab and clears fields when reopened", async ({ page }) => {
    // Open, switch to Create, fill in name, cancel
    await page.locator('button[title="Register project"]').click();
    await page.locator("button", { hasText: "Create new" }).click();
    await page.locator('input[placeholder="my-project"]').fill("old-name");
    await page.locator("button", { hasText: /^Cancel$/ }).click();

    // Reopen — should default to Import tab with empty fields
    await page.locator('button[title="Register project"]').click();
    await expect(page.locator('input[placeholder="C:/path/to/repo"]')).toBeVisible();
    await expect(page.locator('input[placeholder="C:/path/to/repo"]')).toHaveValue("");
  });
});
