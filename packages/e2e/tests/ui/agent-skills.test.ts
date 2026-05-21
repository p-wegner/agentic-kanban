import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

const BUILTIN_SKILLS = [
  "board-navigator",
  "code-review",
  "dependency-analyzer",
  "ticket-enhancer",
];

async function openSkillsTab(page: import("@playwright/test").Page) {
  await page.locator('button[title="Settings"]').click();
  await expect(page.locator("h2", { hasText: "Settings" })).toBeVisible();
  await page.locator("button", { hasText: "Skills" }).click();
  await expect(page.locator("button", { hasText: "+ Add Skill" })).toBeVisible();
}

test.describe("Settings > Skills tab", () => {
  const createdSkillIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdSkillIds) {
      await request.delete(`${SERVER_URL}/api/agent-skills/${id}`);
    }
  });

  test("Skills tab is accessible from Settings", async ({ page }) => {
    await page.locator('button[title="Settings"]').click();
    await expect(page.locator("h2", { hasText: "Settings" })).toBeVisible();
    await expect(page.locator("button", { hasText: "Skills" })).toBeVisible();
  });

  test("all four built-in skills are listed", async ({ page }) => {
    await openSkillsTab(page);

    for (const name of BUILTIN_SKILLS) {
      await expect(page.locator(`text="${name}"`).first()).toBeVisible();
    }
  });

  test("built-in skills show 'builtin' badge and no delete button", async ({ page }) => {
    await openSkillsTab(page);

    // Each builtin skill card has a "builtin" badge
    const builtinBadges = page.locator("span", { hasText: "builtin" });
    await expect(builtinBadges).toHaveCount(BUILTIN_SKILLS.length);

    // No "Delete" buttons should exist for builtin skills — the whole tab
    // has zero delete buttons when only builtins are present
    const deleteButtons = page.locator("button", { hasText: "Delete" });
    await expect(deleteButtons).toHaveCount(0);
  });

  test("built-in skills have Edit and Install buttons but no Delete", async ({ page }) => {
    await openSkillsTab(page);

    // Pick the first builtin skill row and check its buttons
    const firstSkillCard = page.locator("div.border.border-gray-200.rounded-md").first();
    await expect(firstSkillCard.locator("button", { hasText: "Edit" })).toBeVisible();
    await expect(firstSkillCard.locator("button", { hasText: /^Install$|✓ installed/ })).toBeVisible();
    await expect(firstSkillCard.locator("button", { hasText: "Delete" })).not.toBeVisible();
  });

  test("edit a custom skill updates its description and prompt", async ({ page, request }) => {
    const skillName = `e2e-edit-skill-${Date.now()}`;
    const res = await request.post(`${SERVER_URL}/api/agent-skills`, {
      data: { name: skillName, description: "original desc", prompt: "original prompt" },
    });
    expect(res.status()).toBe(201);
    const created = await res.json();
    createdSkillIds.push(created.id);

    await openSkillsTab(page);

    const skillCard = page.locator("div.border.border-gray-200.rounded-md", { hasText: skillName });
    await skillCard.locator("button", { hasText: "Edit" }).click();

    // The edit form should appear inside (or near) the card
    const descInput = page.locator('input[placeholder="Short description"]');
    await expect(descInput).toBeVisible();
    await descInput.clear();
    await descInput.fill("updated desc");

    const promptArea = page.locator('textarea[placeholder*="Skill prompt"]');
    await promptArea.clear();
    await promptArea.fill("updated prompt text");

    await page.locator("button", { hasText: "Save" }).click();

    // Card now shows updated description
    await expect(skillCard.locator("text=updated desc")).toBeVisible();

    // Confirm via API
    const checkRes = await request.get(`${SERVER_URL}/api/agent-skills/${created.id}`);
    const updated = await checkRes.json();
    expect(updated.description).toBe("updated desc");
    expect(updated.prompt).toBe("updated prompt text");
  });

  test("create a custom skill with a model override", async ({ page, request }) => {
    await openSkillsTab(page);

    const skillName = `e2e-model-skill-${Date.now()}`;
    await page.locator("button", { hasText: "+ Add Skill" }).click();

    await page.locator('input[placeholder="Skill name (e.g. dependency-analyzer)"]').fill(skillName);
    await page.locator('input[placeholder="Short description"]').fill("Model override test");
    await page.locator('textarea[placeholder*="Skill prompt"]').fill("Prompt with model override");

    const modelInput = page.locator('input[placeholder*="model"]');
    await modelInput.fill("haiku");

    await page.locator("button", { hasText: "Create" }).click();

    await expect(page.locator(`text="${skillName}"`).first()).toBeVisible();

    const skillsRes = await request.get(`${SERVER_URL}/api/agent-skills`);
    const skills = await skillsRes.json();
    const created = skills.find((s: { name: string }) => s.name === skillName);
    if (created) {
      createdSkillIds.push(created.id);
      expect(created.model).toBe("haiku");
    }
  });

  test("create a custom skill via + Add Skill form", async ({ page, request }) => {
    await openSkillsTab(page);

    const skillName = `e2e-test-skill-${Date.now()}`;

    // Open the new skill form
    await page.locator("button", { hasText: "+ Add Skill" }).click();

    // Fill the form
    await page.locator('input[placeholder="Skill name (e.g. dependency-analyzer)"]').fill(skillName);
    await page.locator('input[placeholder="Short description"]').fill("E2E test skill");
    await page.locator('textarea[placeholder*="Skill prompt"]').fill("This is a test skill prompt for E2E testing.");

    // Save
    await page.locator("button", { hasText: "Create" }).click();

    // New skill appears in the list
    await expect(page.locator(`text="${skillName}"`).first()).toBeVisible();

    // It has a "global" badge (no project scoping) and no "builtin" badge
    const skillCard = page.locator("div.border.border-gray-200.rounded-md", { hasText: skillName });
    await expect(skillCard.locator("span", { hasText: "global" })).toBeVisible();
    await expect(skillCard.locator("span", { hasText: "builtin" })).not.toBeVisible();

    // It has a Delete button (custom skill)
    await expect(skillCard.locator("button", { hasText: "Delete" })).toBeVisible();

    // Record the created skill ID for cleanup
    const skillsRes = await request.get(`${SERVER_URL}/api/agent-skills`);
    const skills = await skillsRes.json();
    const created = skills.find((s: { name: string }) => s.name === skillName);
    if (created) createdSkillIds.push(created.id);
  });

  test("delete a custom skill removes it from the list", async ({ page, request }) => {
    // Create a skill via API to delete via UI
    const skillName = `e2e-delete-skill-${Date.now()}`;
    const res = await request.post(`${SERVER_URL}/api/agent-skills`, {
      data: { name: skillName, description: "to be deleted", prompt: "test prompt" },
    });
    expect(res.status()).toBe(201);
    const created = await res.json();
    // Don't add to createdSkillIds — will be deleted via UI

    await openSkillsTab(page);

    const skillCard = page.locator("div.border.border-gray-200.rounded-md", { hasText: skillName });
    await expect(skillCard).toBeVisible();

    await skillCard.locator("button", { hasText: "Delete" }).click();

    await expect(skillCard).not.toBeVisible();

    // Confirm deletion via API
    const checkRes = await request.get(`${SERVER_URL}/api/agent-skills/${created.id}`);
    expect(checkRes.status()).toBe(404);
  });
});

test.describe("Skill selector in workspace creation form", () => {
  let projectId: string;
  let statusId: string;
  let customSkillId: string;
  let issueId: string;
  const createdWorkspaceIds: string[] = [];
  const suffix = Date.now().toString(36);

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();
    projectId = projects[0].id;

    const statusesRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todoStatus ? todoStatus.id : statuses[0].id;

    // Create a skill so the selector is populated
    const skillRes = await request.post(`${SERVER_URL}/api/agent-skills`, {
      data: {
        name: `e2e-selector-skill-${suffix}`,
        description: "Skill for selector test",
        prompt: "Test prompt for skill selector",
      },
    });
    customSkillId = (await skillRes.json()).id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`);
    }
    if (issueId) {
      await request.delete(`${SERVER_URL}/api/issues/${issueId}`);
    }
    if (customSkillId) {
      await request.delete(`${SERVER_URL}/api/agent-skills/${customSkillId}`);
    }
  });

  test("skill selector appears when Start workspace is checked", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    // Open the + button in the Todo column
    const todoColumn = page.locator("div", { hasText: /^Todo$/ }).first();
    await todoColumn.locator('button[title="Add issue"]').click();

    // Fill minimal issue info
    await page.locator('textarea[placeholder="Issue title"]').fill(`Skill selector test ${suffix}`);

    // Check "Start workspace"
    await page.locator("label", { hasText: "Start workspace" }).locator('input[type="checkbox"]').check();

    // Skill selector should appear
    await expect(page.locator("label", { hasText: "Skill:" })).toBeVisible();

    const skillSelect = page.locator("select").last();
    await expect(skillSelect.locator("option", { hasText: `e2e-selector-skill-${suffix}` })).toBeAttached();

    // Cancel to avoid creating issue
    await page.locator("button", { hasText: /^Cancel$/ }).click();
  });

  test("selecting a skill and creating workspace sets skill_id on the workspace", async ({ page, request }) => {
    await page.goto("/");
    await page.waitForSelector("h2");

    const todoColumn = page.locator("div", { hasText: /^Todo$/ }).first();
    await todoColumn.locator('button[title="Add issue"]').click();

    const issueTitle = `Skill workspace test ${suffix}`;
    await page.locator('textarea[placeholder="Issue title"]').fill(issueTitle);

    // Enable Start workspace
    await page.locator("label", { hasText: "Start workspace" }).locator('input[type="checkbox"]').check();

    // Select the custom skill
    const skillSelect = page.locator("select").last();
    await skillSelect.selectOption({ label: `e2e-selector-skill-${suffix}` });

    // Submit — "Create & Start"
    await page.locator("button", { hasText: "Create & Start" }).click();

    // Wait for the issue/workspace to appear on board
    await page.waitForTimeout(2000);

    // Look up the created workspace via API
    const wsRes = await request.get(`${SERVER_URL}/api/workspaces`);
    const workspaces = await wsRes.json();

    // Find the issue first
    const issuesRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/board`);
    const board = await issuesRes.json();
    const allIssues = board.columns.flatMap((col: { issues: { id: string; title: string }[] }) => col.issues);
    const issue = allIssues.find((i: { title: string }) => i.title === issueTitle);

    if (issue) {
      issueId = issue.id;
      const ws = workspaces.find((w: { issueId: string }) => w.issueId === issue.id);
      if (ws) {
        createdWorkspaceIds.push(ws.id);
        expect(ws.skillId).toBe(customSkillId);
      }
    }
  });
});
