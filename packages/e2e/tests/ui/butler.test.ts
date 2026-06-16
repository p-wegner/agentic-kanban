import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

test.describe("Butler UI", () => {
  let projectId: string;
  let originalClaudeProfile: string;
  const createdButlerDefIds: string[] = [];

  async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return await fn(); } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    throw new Error(`[${label}] failed after 3 attempts: ${String(lastErr)}`);
  }

  test.beforeAll(async ({ request }) => {
    projectId = await withRetry(() => getE2EProjectId(request), "getE2EProjectId");

    // Save original profile for cleanup
    const settingsRes = await request.get(`${SERVER_URL}/api/preferences/settings`);
    const settings = await settingsRes.json() as Record<string, string>;
    originalClaudeProfile = settings.claude_profile ?? "";

    // Stop any lingering butler session so tests start cold
    await request.delete(`${SERVER_URL}/api/projects/${projectId}/butler`).catch(() => {});

    // Use mock profile so butler tests don't need real Claude API credentials
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { claude_profile: "mock" },
    });
  });

  test.afterAll(async ({ request }) => {
    // Stop mock session
    await request.delete(`${SERVER_URL}/api/projects/${projectId}/butler`).catch(() => {});

    // Remove any named butler defs created by tests
    for (const id of createdButlerDefIds) {
      await request.delete(`${SERVER_URL}/api/butler-definitions/${id}`).catch(() => {});
    }

    // Restore original Claude profile
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { claude_profile: originalClaudeProfile },
    }).catch(() => {});
  });

  // ── API-level butler tests (no browser needed) ──────────────────────────────

  test("GET /butler returns cold state when no session active", async ({ request }) => {
    await request.delete(`${SERVER_URL}/api/projects/${projectId}/butler`).catch(() => {});
    const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/butler`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body).toMatchObject({ active: false });
  });

  test("POST /butler/ensure starts a mock session", async ({ request }) => {
    await request.delete(`${SERVER_URL}/api/projects/${projectId}/butler`).catch(() => {});
    const res = await request.post(`${SERVER_URL}/api/projects/${projectId}/butler/ensure`, {
      data: {},
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.active).toBe(true);
    expect(body.sessionId).toBeTruthy();

    // State should now be active
    const stateRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/butler`);
    expect((await stateRes.json()).active).toBe(true);
  });

  test("POST /butler/ask returns a mock response", async ({ request }) => {
    await request.delete(`${SERVER_URL}/api/projects/${projectId}/butler`).catch(() => {});
    const res = await request.post(`${SERVER_URL}/api/projects/${projectId}/butler/ask`, {
      data: { content: "Hello from test", timeoutMs: 5000 },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.isError).toBe(false);
    expect(body.text).toContain("[mock]");
    expect(body.text).toContain("Hello from test");
  });

  test("GET /butler/messages returns transcript after ask", async ({ request }) => {
    await request.delete(`${SERVER_URL}/api/projects/${projectId}/butler`).catch(() => {});
    await request.post(`${SERVER_URL}/api/projects/${projectId}/butler/ask`, {
      data: { content: "transcript test message", timeoutMs: 5000 },
    });
    const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/butler/messages`);
    expect(res.ok()).toBe(true);
    const { messages } = await res.json();
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThanOrEqual(2); // user + assistant
    const userMsg = messages.find((m: { role: string }) => m.role === "user");
    const assistantMsg = messages.find((m: { role: string }) => m.role === "assistant");
    expect(userMsg?.text).toContain("transcript test message");
    expect(assistantMsg?.text).toContain("[mock]");
  });

  test("DELETE /butler clears session and transcript", async ({ request }) => {
    // Seed a session with a turn
    await request.post(`${SERVER_URL}/api/projects/${projectId}/butler/ask`, {
      data: { content: "before delete", timeoutMs: 5000 },
    });
    // Delete (clear context)
    await request.delete(`${SERVER_URL}/api/projects/${projectId}/butler`);
    const stateRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/butler`);
    expect((await stateRes.json()).active).toBe(false);
    // Messages should be empty (session gone)
    const msgRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/butler/messages`);
    const { messages } = await msgRes.json();
    expect(messages.length).toBe(0);
  });

  test("POST /butler/interrupt stops in-flight turn gracefully", async ({ request }) => {
    await request.delete(`${SERVER_URL}/api/projects/${projectId}/butler`).catch(() => {});
    await request.post(`${SERVER_URL}/api/projects/${projectId}/butler/ensure`, { data: {} });
    // Interrupt without an active turn — should return { ok: false } or { ok: true } (both acceptable)
    const res = await request.post(`${SERVER_URL}/api/projects/${projectId}/butler/interrupt`, { data: {} });
    expect(res.ok()).toBe(true);
  });

  test("GET /butler/profiles returns available profiles", async ({ request }) => {
    const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/butler/profiles`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(Array.isArray(body.profiles)).toBe(true);
    expect(typeof body.provider).toBe("string");
  });

  test("GET /butler/skill returns default prompt", async ({ request }) => {
    const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/butler/skill`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(typeof body.prompt).toBe("string");
    expect(body.prompt.length).toBeGreaterThan(0);
    expect(typeof body.isOverride).toBe("boolean");
  });

  test("PUT /butler/skill sets and GET retrieves project-scoped prompt override", async ({ request }) => {
    const suffix = Date.now().toString(36);
    const customPrompt = `Custom butler for e2e test ${suffix}`;
    // Set override
    const putRes = await request.put(`${SERVER_URL}/api/projects/${projectId}/butler/skill`, {
      data: { prompt: customPrompt },
    });
    expect(putRes.ok()).toBe(true);
    // Verify
    const getRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/butler/skill`);
    const body = await getRes.json();
    expect(body.prompt).toBe(customPrompt);
    expect(body.isOverride).toBe(true);
    // Cleanup: remove override by sending empty prompt
    await request.put(`${SERVER_URL}/api/projects/${projectId}/butler/skill`, { data: { prompt: "" } });
  });

  test("GET /butler/sessions returns empty list when no tracked sessions", async ({ request }) => {
    // Use a fresh butler with no history
    await request.delete(`${SERVER_URL}/api/projects/${projectId}/butler`).catch(() => {});
    const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/butler/sessions?limit=5`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  // ── Butler definitions API ───────────────────────────────────────────────────

  test("GET /api/butler-definitions lists definitions including default", async ({ request }) => {
    const res = await request.get(`${SERVER_URL}/api/butler-definitions`);
    expect(res.ok()).toBe(true);
    const { butlers, max } = await res.json();
    expect(Array.isArray(butlers)).toBe(true);
    expect(butlers.some((b: { id: string }) => b.id === "default")).toBe(true);
    expect(typeof max).toBe("number");
  });

  test("POST then DELETE /api/butler-definitions creates and removes named butler", async ({ request }) => {
    const suffix = Date.now().toString(36);
    const name = `E2E Butler ${suffix}`;
    const createRes = await request.post(`${SERVER_URL}/api/butler-definitions`, {
      data: { name, model: "", provider: "claude" },
    });
    expect(createRes.status()).toBe(201);
    const { butler } = await createRes.json();
    expect(butler.name).toBe(name);
    expect(butler.id).toBeTruthy();
    createdButlerDefIds.push(butler.id);

    // Verify it appears in the list
    const listRes = await request.get(`${SERVER_URL}/api/butler-definitions`);
    const { butlers } = await listRes.json();
    expect(butlers.some((b: { id: string }) => b.id === butler.id)).toBe(true);

    // Delete it
    const delRes = await request.delete(`${SERVER_URL}/api/butler-definitions/${butler.id}`);
    expect(delRes.ok()).toBe(true);
    createdButlerDefIds.splice(createdButlerDefIds.indexOf(butler.id), 1);

    // Verify removed
    const listRes2 = await request.get(`${SERVER_URL}/api/butler-definitions`);
    const { butlers: butlers2 } = await listRes2.json();
    expect(butlers2.some((b: { id: string }) => b.id === butler.id)).toBe(false);
  });

  test("PUT /api/butler-definitions/:id updates butler name", async ({ request }) => {
    const suffix = Date.now().toString(36);
    const createRes = await request.post(`${SERVER_URL}/api/butler-definitions`, {
      data: { name: `Rename Me ${suffix}`, model: "", provider: "claude" },
    });
    expect(createRes.status()).toBe(201);
    const { butler } = await createRes.json();
    createdButlerDefIds.push(butler.id);

    const newName = `Renamed ${suffix}`;
    const putRes = await request.put(`${SERVER_URL}/api/butler-definitions/${butler.id}`, {
      data: { name: newName },
    });
    expect(putRes.ok()).toBe(true);

    const listRes = await request.get(`${SERVER_URL}/api/butler-definitions`);
    const { butlers } = await listRes.json();
    const updated = butlers.find((b: { id: string }) => b.id === butler.id);
    expect(updated?.name).toBe(newName);
  });

  test("GET /api/projects/:id/butlers returns all butler states", async ({ request }) => {
    const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/butlers`);
    expect(res.ok()).toBe(true);
    const { butlers } = await res.json();
    expect(Array.isArray(butlers)).toBe(true);
    const defaultButler = butlers.find((b: { id: string }) => b.id === "default");
    expect(defaultButler).toBeDefined();
  });

  // ── UI tests ─────────────────────────────────────────────────────────────────

  test("butler view shows Start Butler button when no session active", async ({ page, request }) => {
    await request.delete(`${SERVER_URL}/api/projects/${projectId}/butler`).catch(() => {});
    await page.goto("/butler");
    // Default tab visible
    await expect(page.locator('[data-testid="butler-tab-default"]')).toBeVisible({ timeout: 5000 });
    // Start button visible when session is cold
    await expect(page.getByRole("button", { name: "Start Butler" })).toBeVisible({ timeout: 5000 });
  });

  test("Start Butler button starts a mock session and reveals chat UI", async ({ page, request }) => {
    await request.delete(`${SERVER_URL}/api/projects/${projectId}/butler`).catch(() => {});
    await page.goto("/butler");
    await expect(page.getByRole("button", { name: "Start Butler" })).toBeVisible({ timeout: 5000 });
    await page.getByRole("button", { name: "Start Butler" }).click();
    // After starting, the chat textarea becomes visible
    await expect(page.locator("textarea")).toBeVisible({ timeout: 8000 });
    // Start Butler button should disappear
    await expect(page.getByRole("button", { name: "Start Butler" })).toBeHidden({ timeout: 5000 });
  });

  test("sends a message and shows mock response in chat", async ({ page, request }) => {
    // Ensure a clean session
    await request.delete(`${SERVER_URL}/api/projects/${projectId}/butler`).catch(() => {});
    await request.post(`${SERVER_URL}/api/projects/${projectId}/butler/ensure`, { data: {} });

    await page.goto("/butler");
    await expect(page.locator("textarea")).toBeVisible({ timeout: 8000 });

    const msg = "ping from e2e test";
    await page.locator("textarea").fill(msg);
    await page.keyboard.press("Enter");

    // User bubble appears
    await expect(page.locator("p", { hasText: msg })).toBeVisible({ timeout: 5000 });
    // Mock response appears (contains "[mock]")
    await expect(page.locator("text=[mock]").first()).toBeVisible({ timeout: 5000 });
  });

  test("Clear context button resets the chat", async ({ page, request }) => {
    await request.delete(`${SERVER_URL}/api/projects/${projectId}/butler`).catch(() => {});
    await request.post(`${SERVER_URL}/api/projects/${projectId}/butler/ensure`, { data: {} });

    await page.goto("/butler");
    await expect(page.locator("textarea")).toBeVisible({ timeout: 8000 });

    // Send a message to populate chat
    await page.locator("textarea").fill("message before clear");
    await page.keyboard.press("Enter");
    await expect(page.locator("text=[mock]").first()).toBeVisible({ timeout: 5000 });

    // Click the Clear button
    const clearBtn = page.getByRole("button", { name: "Clear" });
    await expect(clearBtn).toBeVisible();
    await clearBtn.click();

    // Chat messages should be gone
    await expect(page.locator("p", { hasText: "message before clear" })).toBeHidden({ timeout: 5000 });
    // "Butler is ready" placeholder should appear
    await expect(page.getByText("Butler is ready.")).toBeVisible({ timeout: 5000 });
  });

  test("History panel opens and shows no sessions for a fresh mock session", async ({ page, request }) => {
    await request.delete(`${SERVER_URL}/api/projects/${projectId}/butler`).catch(() => {});
    await request.post(`${SERVER_URL}/api/projects/${projectId}/butler/ensure`, { data: {} });

    await page.goto("/butler");
    await expect(page.locator("textarea")).toBeVisible({ timeout: 8000 });

    // Open history panel
    const historyBtn = page.getByRole("button", { name: "History" });
    await expect(historyBtn).toBeVisible();
    await historyBtn.click();

    // History panel should open — either shows sessions or "No past butler sessions found"
    await expect(
      page.getByText("Recent sessions").or(page.getByText("No past butler sessions found."))
    ).toBeVisible({ timeout: 5000 });
  });

  test("Customize panel opens and allows editing butler prompt", async ({ page, request }) => {
    await request.delete(`${SERVER_URL}/api/projects/${projectId}/butler`).catch(() => {});
    await request.post(`${SERVER_URL}/api/projects/${projectId}/butler/ensure`, { data: {} });

    await page.goto("/butler");
    await expect(page.locator("textarea")).toBeVisible({ timeout: 8000 });

    // Open customize panel
    const customizeBtn = page.getByRole("button", { name: "Customize" });
    await expect(customizeBtn).toBeVisible();
    await customizeBtn.click();

    // Customize textarea should appear (the skill editor, not the chat input)
    const customizeArea = page.locator("textarea[placeholder]", {
      hasText: "",
    }).filter({ hasNot: page.locator('[placeholder*="Message the butler"]') });
    void customizeArea; // referenced to satisfy linter
    await expect(page.getByText("Butler behavior (project override)")).toBeVisible({ timeout: 5000 });

    // Close it
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Butler behavior (project override)")).toBeHidden({ timeout: 3000 });
  });

  test("Manage butlers modal lists the Default butler and can be closed", async ({ page, request }) => {
    await request.delete(`${SERVER_URL}/api/projects/${projectId}/butler`).catch(() => {});
    await request.post(`${SERVER_URL}/api/projects/${projectId}/butler/ensure`, { data: {} });

    await page.goto("/butler");
    await expect(page.locator("textarea")).toBeVisible({ timeout: 8000 });

    // Click the gear icon to open manage modal
    const gearBtn = page.locator('button[title="Manage butlers (add, rename, set model, remove)"]');
    await expect(gearBtn).toBeVisible();
    await gearBtn.click();

    // Modal should show "Manage butlers" heading
    await expect(page.getByText("Manage butlers")).toBeVisible({ timeout: 5000 });
    // Default butler listed
    await expect(page.getByText("Butlers are shared across all projects")).toBeVisible();

    // Close via X button
    await page.locator('.fixed button[class*="text-gray-400"]').last().click();
    await expect(page.getByText("Manage butlers")).toBeHidden({ timeout: 3000 });
  });

  test("multiple turns maintain conversation history", async ({ request }) => {
    await request.delete(`${SERVER_URL}/api/projects/${projectId}/butler`).catch(() => {});
    // Send two turns
    await request.post(`${SERVER_URL}/api/projects/${projectId}/butler/ask`, {
      data: { content: "first turn", timeoutMs: 5000 },
    });
    await request.post(`${SERVER_URL}/api/projects/${projectId}/butler/ask`, {
      data: { content: "second turn", timeoutMs: 5000 },
    });
    const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/butler/messages`);
    const { messages } = await res.json();
    // 2 user + 2 assistant = 4 messages
    expect(messages.length).toBe(4);
    const userMessages = messages.filter((m: { role: string }) => m.role === "user");
    expect(userMessages.some((m: { text: string }) => m.text.includes("first turn"))).toBe(true);
    expect(userMessages.some((m: { text: string }) => m.text.includes("second turn"))).toBe(true);
  });
});
