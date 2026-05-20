import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

const VALID_REPO_PATH = "C:/andrena/agentic-kanban";

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 3240b24 (feat: expand E2E tests for create-project and import flows)
async function openModal(page: import("@playwright/test").Page) {
  await page.locator('button[title="Register project"]').click();
  await expect(page.locator("h2", { hasText: "Add Project" })).toBeVisible();
}

<<<<<<< HEAD
=======
>>>>>>> 7776b38 (feat: add E2E tests for create-project flow (WIP))
=======
>>>>>>> 3240b24 (feat: expand E2E tests for create-project and import flows)
=======
>>>>>>> 0c8a99f (feat: add E2E tests for create-project flow (WIP))
test.describe("Register Project UI", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h1");
  });

  test("register button is visible in header", async ({ page }) => {
    const registerBtn = page.locator('button[title="Register project"]');
    await expect(registerBtn).toBeVisible();
  });

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 3240b24 (feat: expand E2E tests for create-project and import flows)
  test("clicking register button opens modal with two tabs", async ({ page }) => {
    await openModal(page);
    await expect(page.locator("button", { hasText: "Import existing" })).toBeVisible();
    await expect(page.locator("button", { hasText: "Create new" })).toBeVisible();
  });

  test("Import existing tab shows repo path input by default", async ({ page }) => {
    await openModal(page);
<<<<<<< HEAD
=======
  test("clicking register button opens modal", async ({ page }) => {
    await page.locator('button[title="Register project"]').click();
    await expect(page.locator("h2", { hasText: "Register Project" })).toBeVisible();
>>>>>>> 7776b38 (feat: add E2E tests for create-project flow (WIP))
=======
>>>>>>> 3240b24 (feat: expand E2E tests for create-project and import flows)
=======
  test("clicking register button opens modal", async ({ page }) => {
    await page.locator('button[title="Register project"]').click();
    await expect(page.locator("h2", { hasText: "Register Project" })).toBeVisible();
>>>>>>> 0c8a99f (feat: add E2E tests for create-project flow (WIP))
    await expect(page.locator('input[placeholder="C:/path/to/repo"]')).toBeVisible();
    await expect(page.locator("text=Absolute path to a git repository")).toBeVisible();
  });

  test("Register button is disabled when path is empty", async ({ page }) => {
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
    await openModal(page);
=======
    await page.locator('button[title="Register project"]').click();
    await expect(page.locator("h2", { hasText: "Register Project" })).toBeVisible();

>>>>>>> 7776b38 (feat: add E2E tests for create-project flow (WIP))
=======
    await openModal(page);
>>>>>>> 3240b24 (feat: expand E2E tests for create-project and import flows)
=======
    await page.locator('button[title="Register project"]').click();
    await expect(page.locator("h2", { hasText: "Register Project" })).toBeVisible();

>>>>>>> 0c8a99f (feat: add E2E tests for create-project flow (WIP))
    const submitBtn = page.locator('button[type="submit"]', { hasText: /Register/ });
    await expect(submitBtn).toBeDisabled();
  });

  test("Register button enables when path is entered", async ({ page }) => {
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
    await openModal(page);
    await page.locator('input[placeholder="C:/path/to/repo"]').fill("/some/path");
=======
=======
>>>>>>> 0c8a99f (feat: add E2E tests for create-project flow (WIP))
    await page.locator('button[title="Register project"]').click();

    const input = page.locator('input[placeholder="C:/path/to/repo"]');
    await input.fill("/some/path");

<<<<<<< HEAD
>>>>>>> 7776b38 (feat: add E2E tests for create-project flow (WIP))
=======
    await openModal(page);
    await page.locator('input[placeholder="C:/path/to/repo"]').fill("/some/path");
>>>>>>> 3240b24 (feat: expand E2E tests for create-project and import flows)
=======
>>>>>>> 0c8a99f (feat: add E2E tests for create-project flow (WIP))
    const submitBtn = page.locator('button[type="submit"]', { hasText: /Register/ });
    await expect(submitBtn).toBeEnabled();
  });

  test("Cancel button closes the modal", async ({ page }) => {
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
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
=======
    await page.locator('button[title="Register project"]').click();
    await expect(page.locator("h2", { hasText: "Register Project" })).toBeVisible();

=======
    await openModal(page);
>>>>>>> 3240b24 (feat: expand E2E tests for create-project and import flows)
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

<<<<<<< HEAD
    await page.locator('button[title="Register project"]').click();
>>>>>>> 7776b38 (feat: add E2E tests for create-project flow (WIP))
=======
    await openModal(page);
>>>>>>> 3240b24 (feat: expand E2E tests for create-project and import flows)
=======
    await page.locator('button[title="Register project"]').click();
    await expect(page.locator("h2", { hasText: "Register Project" })).toBeVisible();

    await page.locator("button", { hasText: /^Cancel$/ }).click();
    await expect(page.locator("h2", { hasText: "Register Project" })).not.toBeVisible();
  });

  test("clicking backdrop closes the modal", async ({ page }) => {
    await page.locator('button[title="Register project"]').click();
    await expect(page.locator("h2", { hasText: "Register Project" })).toBeVisible();

    // Click the backdrop (outside the modal card)
    await page.locator(".fixed.inset-0.bg-black\\/40").click({ position: { x: 10, y: 10 } });
    await expect(page.locator("h2", { hasText: "Register Project" })).not.toBeVisible();
  });

  test("modal clears input when reopened", async ({ page }) => {
    await page.locator('button[title="Register project"]').click();
    await page.locator('input[placeholder="C:/path/to/repo"]').fill("/some/path");
    await page.locator("button", { hasText: /^Cancel$/ }).click();

    await page.locator('button[title="Register project"]').click();
>>>>>>> 0c8a99f (feat: add E2E tests for create-project flow (WIP))
    await expect(page.locator('input[placeholder="C:/path/to/repo"]')).toHaveValue("");
  });

  test("invalid path (not a git repo) shows error", async ({ page }) => {
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
    await openModal(page);
=======
    await page.locator('button[title="Register project"]').click();

>>>>>>> 7776b38 (feat: add E2E tests for create-project flow (WIP))
=======
    await openModal(page);
>>>>>>> 3240b24 (feat: expand E2E tests for create-project and import flows)
=======
    await page.locator('button[title="Register project"]').click();

>>>>>>> 0c8a99f (feat: add E2E tests for create-project flow (WIP))
    await page.locator('input[placeholder="C:/path/to/repo"]').fill("C:/nonexistent/path/xyz");
    await page.locator('button[type="submit"]', { hasText: /Register/ }).click();

    await expect(page.locator("p.text-red-600")).toBeVisible();
    // Modal stays open on error
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
    await expect(page.locator("h2", { hasText: "Add Project" })).toBeVisible();
  });

  test("duplicate path shows error message", async ({ page }) => {
=======
=======
>>>>>>> 0c8a99f (feat: add E2E tests for create-project flow (WIP))
    await expect(page.locator("h2", { hasText: "Register Project" })).toBeVisible();
  });

  test("duplicate path shows error message", async ({ page }) => {
    // Route the register API to return a 409 conflict
<<<<<<< HEAD
>>>>>>> 7776b38 (feat: add E2E tests for create-project flow (WIP))
=======
    await expect(page.locator("h2", { hasText: "Add Project" })).toBeVisible();
  });

  test("duplicate path shows error message", async ({ page }) => {
>>>>>>> 3240b24 (feat: expand E2E tests for create-project and import flows)
=======
>>>>>>> 0c8a99f (feat: add E2E tests for create-project flow (WIP))
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

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
    await openModal(page);
=======
    await page.locator('button[title="Register project"]').click();
>>>>>>> 7776b38 (feat: add E2E tests for create-project flow (WIP))
=======
    await openModal(page);
>>>>>>> 3240b24 (feat: expand E2E tests for create-project and import flows)
=======
    await page.locator('button[title="Register project"]').click();
>>>>>>> 0c8a99f (feat: add E2E tests for create-project flow (WIP))
    await page.locator('input[placeholder="C:/path/to/repo"]').fill(VALID_REPO_PATH);
    await page.locator('button[type="submit"]', { hasText: /Register/ }).click();

    await expect(page.locator("p.text-red-600")).toBeVisible();
    await expect(page.locator("p.text-red-600")).toContainText("already registered");
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
    await expect(page.locator("h2", { hasText: "Add Project" })).toBeVisible();
=======
    // Modal stays open
    await expect(page.locator("h2", { hasText: "Register Project" })).toBeVisible();
>>>>>>> 7776b38 (feat: add E2E tests for create-project flow (WIP))
=======
    await expect(page.locator("h2", { hasText: "Add Project" })).toBeVisible();
>>>>>>> 3240b24 (feat: expand E2E tests for create-project and import flows)
=======
    // Modal stays open
    await expect(page.locator("h2", { hasText: "Register Project" })).toBeVisible();
>>>>>>> 0c8a99f (feat: add E2E tests for create-project flow (WIP))
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

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
    await openModal(page);
=======
    await page.locator('button[title="Register project"]').click();
>>>>>>> 7776b38 (feat: add E2E tests for create-project flow (WIP))
=======
    await openModal(page);
>>>>>>> 3240b24 (feat: expand E2E tests for create-project and import flows)
=======
    await page.locator('button[title="Register project"]').click();
>>>>>>> 0c8a99f (feat: add E2E tests for create-project flow (WIP))
    await page.locator('input[placeholder="C:/path/to/repo"]').fill("/not/a/git/repo");
    await page.locator('button[type="submit"]', { hasText: /Register/ }).click();

    await expect(page.locator("p.text-red-600")).toBeVisible();
    await expect(page.locator("p.text-red-600")).toContainText("not a git repository");
  });

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
  test("successful registration closes modal and sends correct path", async ({ page }) => {
=======
=======
>>>>>>> 0c8a99f (feat: add E2E tests for create-project flow (WIP))
  test("successful registration closes modal and adds project", async ({ page }) => {
    // Get current projects count
    const initialProjects = await (await fetch(`${SERVER_URL}/api/projects`)).json();
    const initialCount = initialProjects.length;

    // Mock successful registration to avoid actually registering a new project
<<<<<<< HEAD
>>>>>>> 7776b38 (feat: add E2E tests for create-project flow (WIP))
=======
  test("successful registration closes modal and sends correct path", async ({ page }) => {
>>>>>>> 3240b24 (feat: expand E2E tests for create-project and import flows)
=======
>>>>>>> 0c8a99f (feat: add E2E tests for create-project flow (WIP))
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

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
    await openModal(page);
    await page.locator('input[placeholder="C:/path/to/repo"]').fill("/some/repo/path");
    await page.locator('button[type="submit"]', { hasText: /Register/ }).click();

    await expect(page.locator("h2", { hasText: "Add Project" })).not.toBeVisible();
=======
=======
>>>>>>> 0c8a99f (feat: add E2E tests for create-project flow (WIP))
    await page.locator('button[title="Register project"]').click();
    await page.locator('input[placeholder="C:/path/to/repo"]').fill("/some/repo/path");
    await page.locator('button[type="submit"]', { hasText: /Register/ }).click();

    // Modal closes on success
    await expect(page.locator("h2", { hasText: "Register Project" })).not.toBeVisible();

    // Verify the path was sent to the API
<<<<<<< HEAD
>>>>>>> 7776b38 (feat: add E2E tests for create-project flow (WIP))
=======
    await openModal(page);
    await page.locator('input[placeholder="C:/path/to/repo"]').fill("/some/repo/path");
    await page.locator('button[type="submit"]', { hasText: /Register/ }).click();

    await expect(page.locator("h2", { hasText: "Add Project" })).not.toBeVisible();
>>>>>>> 3240b24 (feat: expand E2E tests for create-project and import flows)
=======
>>>>>>> 0c8a99f (feat: add E2E tests for create-project flow (WIP))
    expect(capturedBody.repoPath).toBe("/some/repo/path");
  });

  test("shows Registering… label while submitting", async ({ page }) => {
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
    // Delay the response to catch the loading state
>>>>>>> 7776b38 (feat: add E2E tests for create-project flow (WIP))
=======
>>>>>>> 3240b24 (feat: expand E2E tests for create-project and import flows)
=======
    // Delay the response to catch the loading state
>>>>>>> 0c8a99f (feat: add E2E tests for create-project flow (WIP))
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

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
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
=======
    await page.locator('button[title="Register project"]').click();
=======
    await openModal(page);
>>>>>>> 3240b24 (feat: expand E2E tests for create-project and import flows)
    await page.locator('input[placeholder="C:/path/to/repo"]').fill("/some/repo");
    await page.locator('button[type="submit"]', { hasText: /Register/ }).click();

    await expect(page.locator('button[type="submit"]', { hasText: "Registering…" })).toBeVisible();
  });
});
<<<<<<< HEAD
>>>>>>> 7776b38 (feat: add E2E tests for create-project flow (WIP))
=======

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
>>>>>>> 3240b24 (feat: expand E2E tests for create-project and import flows)
=======
    await page.locator('button[title="Register project"]').click();
    await page.locator('input[placeholder="C:/path/to/repo"]').fill("/some/repo");
    await page.locator('button[type="submit"]', { hasText: /Register/ }).click();

    // Button should show loading state
    await expect(page.locator('button[type="submit"]', { hasText: "Registering…" })).toBeVisible();
  });
});
>>>>>>> 0c8a99f (feat: add E2E tests for create-project flow (WIP))
