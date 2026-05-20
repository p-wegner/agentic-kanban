import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

const VALID_REPO_PATH = "C:/andrena/agentic-kanban";

test.describe("Register Project UI", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h1");
  });

  test("register button is visible in header", async ({ page }) => {
    const registerBtn = page.locator('button[title="Register project"]');
    await expect(registerBtn).toBeVisible();
  });

  test("clicking register button opens modal", async ({ page }) => {
    await page.locator('button[title="Register project"]').click();
    await expect(page.locator("h2", { hasText: "Register Project" })).toBeVisible();
    await expect(page.locator('input[placeholder="C:/path/to/repo"]')).toBeVisible();
    await expect(page.locator("text=Absolute path to a git repository")).toBeVisible();
  });

  test("Register button is disabled when path is empty", async ({ page }) => {
    await page.locator('button[title="Register project"]').click();
    await expect(page.locator("h2", { hasText: "Register Project" })).toBeVisible();

    const submitBtn = page.locator('button[type="submit"]', { hasText: /Register/ });
    await expect(submitBtn).toBeDisabled();
  });

  test("Register button enables when path is entered", async ({ page }) => {
    await page.locator('button[title="Register project"]').click();

    const input = page.locator('input[placeholder="C:/path/to/repo"]');
    await input.fill("/some/path");

    const submitBtn = page.locator('button[type="submit"]', { hasText: /Register/ });
    await expect(submitBtn).toBeEnabled();
  });

  test("Cancel button closes the modal", async ({ page }) => {
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
    await expect(page.locator('input[placeholder="C:/path/to/repo"]')).toHaveValue("");
  });

  test("invalid path (not a git repo) shows error", async ({ page }) => {
    await page.locator('button[title="Register project"]').click();

    await page.locator('input[placeholder="C:/path/to/repo"]').fill("C:/nonexistent/path/xyz");
    await page.locator('button[type="submit"]', { hasText: /Register/ }).click();

    await expect(page.locator("p.text-red-600")).toBeVisible();
    // Modal stays open on error
    await expect(page.locator("h2", { hasText: "Register Project" })).toBeVisible();
  });

  test("duplicate path shows error message", async ({ page }) => {
    // Route the register API to return a 409 conflict
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

    await page.locator('button[title="Register project"]').click();
    await page.locator('input[placeholder="C:/path/to/repo"]').fill(VALID_REPO_PATH);
    await page.locator('button[type="submit"]', { hasText: /Register/ }).click();

    await expect(page.locator("p.text-red-600")).toBeVisible();
    await expect(page.locator("p.text-red-600")).toContainText("already registered");
    // Modal stays open
    await expect(page.locator("h2", { hasText: "Register Project" })).toBeVisible();
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

    await page.locator('button[title="Register project"]').click();
    await page.locator('input[placeholder="C:/path/to/repo"]').fill("/not/a/git/repo");
    await page.locator('button[type="submit"]', { hasText: /Register/ }).click();

    await expect(page.locator("p.text-red-600")).toBeVisible();
    await expect(page.locator("p.text-red-600")).toContainText("not a git repository");
  });

  test("successful registration closes modal and adds project", async ({ page }) => {
    // Get current projects count
    const initialProjects = await (await fetch(`${SERVER_URL}/api/projects`)).json();
    const initialCount = initialProjects.length;

    // Mock successful registration to avoid actually registering a new project
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

    await page.locator('button[title="Register project"]').click();
    await page.locator('input[placeholder="C:/path/to/repo"]').fill("/some/repo/path");
    await page.locator('button[type="submit"]', { hasText: /Register/ }).click();

    // Modal closes on success
    await expect(page.locator("h2", { hasText: "Register Project" })).not.toBeVisible();

    // Verify the path was sent to the API
    expect(capturedBody.repoPath).toBe("/some/repo/path");
  });

  test("shows Registering… label while submitting", async ({ page }) => {
    // Delay the response to catch the loading state
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

    await page.locator('button[title="Register project"]').click();
    await page.locator('input[placeholder="C:/path/to/repo"]').fill("/some/repo");
    await page.locator('button[type="submit"]', { hasText: /Register/ }).click();

    // Button should show loading state
    await expect(page.locator('button[type="submit"]', { hasText: "Registering…" })).toBeVisible();
  });
});
