// @covers codemods.get.byid [api]
/**
 * E2E tests for GET /api/codemods/:id.
 *
 * The existing codemod.test.ts only asserts the 404-unknown-id branch and
 * verifies a saved codemod's presence via the LIST endpoint. This file pins
 * the UNASSERTED success edge: GET /api/codemods/:id directly returns the saved
 * codemod's body (api dimension), plus the 404 error-body shape.
 *
 * Mutation check: this test creates one saved codemod (POST /api/codemods),
 * GETs it back by id, then deletes it in afterAll via DELETE /api/agent-skills/:id.
 * No project files, preferences, or other persistent state are mutated.
 */

import { test, expect } from "@playwright/test";
import { SERVER_URL as BASE } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

test.describe("GET /api/codemods/:id", () => {
  let projectId: string;
  const createdSkillIds: string[] = [];

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
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdSkillIds) {
      await request.delete(`${BASE}/api/agent-skills/${id}`).catch(() => {});
    }
  });

  test("returns the saved codemod body for an existing id", async ({ request }) => {
    const suffix = Date.now().toString(36);
    const name = `get-byid-codemod-${suffix}`;
    const description = "Rename Alpha to Beta";
    const script = "// for (const cls of sourceFile.getClasses()) { /* no-op */ }";

    // Arrange: create a saved codemod.
    const created = await withRetry(async () => {
      const res = await request.post(`${BASE}/api/codemods`, {
        data: { name, description, script, projectId },
      });
      if (res.status() !== 201) throw new Error(`create codemod ${res.status()}`);
      return res.json();
    }, "create codemod");
    expect(created.id).toBeDefined();
    createdSkillIds.push(created.id);

    // Act: fetch it directly by id (the unasserted success path).
    const res = await request.get(`${BASE}/api/codemods/${created.id}`);

    // Assert: 200 with the codemod's own body.
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.name).toBe(name);
    expect(body.description).toBe(description);
    expect(body.type).toBe("codemod");
    // The saved script is persisted as the skill's prompt.
    expect(body.prompt).toBe(script);
  });

  test("returns 404 with an error body for an unknown id", async ({ request }) => {
    const res = await request.get(`${BASE}/api/codemods/00000000-0000-0000-0000-000000000000`);
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(body.error).toMatch(/not found/i);
  });
});
