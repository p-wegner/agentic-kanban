import { test, expect } from "@playwright/test";
import { SERVER_URL as BASE } from "../helpers/port.js";

const BUILTIN_SKILLS = [
  "board-navigator",
  "code-review",
  "dependency-analyzer",
  "monitor-nudge",
  "ticket-enhancer",
];

test.describe("Agent Skills API", () => {
  const createdIds: string[] = [];
  const suffix = Date.now().toString(36);

  test.afterAll(async ({ request }) => {
    for (const id of createdIds) {
      await request.delete(`${BASE}/api/agent-skills/${id}`);
    }
  });

  test("GET /api/agent-skills returns built-in skills", async ({ request }) => {
    const res = await request.get(`${BASE}/api/agent-skills`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const names = body.map((s: { name: string }) => s.name);
    for (const name of BUILTIN_SKILLS) {
      expect(names).toContain(name);
    }
  });

  test("GET /api/agent-skills built-in skills have isBuiltin: true", async ({ request }) => {
    const res = await request.get(`${BASE}/api/agent-skills`);
    const body = await res.json();
    for (const name of BUILTIN_SKILLS) {
      const skill = body.find((s: { name: string }) => s.name === name);
      expect(skill).toBeDefined();
      expect(skill.isBuiltin).toBe(true);
    }
  });

  test("GET /api/agent-skills?global=true returns only global skills", async ({ request }) => {
    const res = await request.get(`${BASE}/api/agent-skills?global=true`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    for (const skill of body) {
      expect(skill.projectId).toBeNull();
    }
  });

  test("POST /api/agent-skills creates a custom skill", async ({ request }) => {
    const res = await request.post(`${BASE}/api/agent-skills`, {
      data: {
        name: `api-test-skill-${suffix}`,
        description: "API test skill description",
        prompt: "API test skill prompt content",
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBe(`api-test-skill-${suffix}`);
    expect(body.description).toBe("API test skill description");
    expect(body.prompt).toBe("API test skill prompt content");
    expect(body.isBuiltin).toBe(false);
    expect(body.projectId).toBeNull();
    createdIds.push(body.id);
  });

  test("POST /api/agent-skills creates skill with model override", async ({ request }) => {
    const res = await request.post(`${BASE}/api/agent-skills`, {
      data: {
        name: `api-model-skill-${suffix}`,
        description: "Skill with model override",
        prompt: "Prompt for model-overridden skill",
        model: "haiku",
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.model).toBe("haiku");
    createdIds.push(body.id);
  });

  test("POST /api/agent-skills rejects missing name", async ({ request }) => {
    const res = await request.post(`${BASE}/api/agent-skills`, {
      data: { description: "desc", prompt: "prompt" },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/agent-skills rejects missing description", async ({ request }) => {
    const res = await request.post(`${BASE}/api/agent-skills`, {
      data: { name: `no-desc-${suffix}`, prompt: "prompt" },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/agent-skills rejects missing prompt", async ({ request }) => {
    const res = await request.post(`${BASE}/api/agent-skills`, {
      data: { name: `no-prompt-${suffix}`, description: "desc" },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/agent-skills rejects name with path traversal", async ({ request }) => {
    const res = await request.post(`${BASE}/api/agent-skills`, {
      data: { name: "../evil", description: "desc", prompt: "prompt" },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/\/|\\|\.\./);
  });

  test("POST /api/agent-skills rejects duplicate name in same scope", async ({ request }) => {
    const name = `dup-skill-${suffix}`;
    const first = await request.post(`${BASE}/api/agent-skills`, {
      data: { name, description: "first", prompt: "first prompt" },
    });
    expect(first.status()).toBe(201);
    createdIds.push((await first.json()).id);

    const second = await request.post(`${BASE}/api/agent-skills`, {
      data: { name, description: "second", prompt: "second prompt" },
    });
    expect(second.status()).toBe(409);
    const body = await second.json();
    expect(body.error).toContain(name);
  });

  test("GET /api/agent-skills/:id returns the skill", async ({ request }) => {
    const createRes = await request.post(`${BASE}/api/agent-skills`, {
      data: { name: `get-by-id-${suffix}`, description: "desc", prompt: "prompt" },
    });
    const created = await createRes.json();
    createdIds.push(created.id);

    const res = await request.get(`${BASE}/api/agent-skills/${created.id}`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.name).toBe(`get-by-id-${suffix}`);
  });

  test("GET /api/agent-skills/:id returns 404 for unknown id", async ({ request }) => {
    const res = await request.get(`${BASE}/api/agent-skills/00000000-0000-0000-0000-000000000000`);
    expect(res.status()).toBe(404);
  });

  test("PUT /api/agent-skills/:id updates name, description, and prompt", async ({ request }) => {
    const createRes = await request.post(`${BASE}/api/agent-skills`, {
      data: { name: `put-test-${suffix}`, description: "original", prompt: "original prompt" },
    });
    const created = await createRes.json();
    createdIds.push(created.id);

    const putRes = await request.put(`${BASE}/api/agent-skills/${created.id}`, {
      data: { description: "updated desc", prompt: "updated prompt" },
    });
    expect(putRes.ok()).toBeTruthy();
    const updated = await putRes.json();
    expect(updated.description).toBe("updated desc");
    expect(updated.prompt).toBe("updated prompt");

    const getRes = await request.get(`${BASE}/api/agent-skills/${created.id}`);
    const fetched = await getRes.json();
    expect(fetched.description).toBe("updated desc");
  });

  test("PUT /api/agent-skills/:id returns 404 for unknown id", async ({ request }) => {
    const res = await request.put(`${BASE}/api/agent-skills/00000000-0000-0000-0000-000000000000`, {
      data: { description: "new desc" },
    });
    expect(res.status()).toBe(404);
  });

  test("PUT /api/agent-skills/:id rejects updating a built-in skill", async ({ request }) => {
    const listRes = await request.get(`${BASE}/api/agent-skills`);
    const skills = await listRes.json();
    const builtin = skills.find((s: { isBuiltin: boolean }) => s.isBuiltin);
    expect(builtin).toBeDefined();

    const res = await request.put(`${BASE}/api/agent-skills/${builtin.id}`, {
      data: { description: "hacked" },
    });
    expect(res.status()).toBe(403);
  });

  test("DELETE /api/agent-skills/:id deletes a custom skill", async ({ request }) => {
    const createRes = await request.post(`${BASE}/api/agent-skills`, {
      data: { name: `delete-test-${suffix}`, description: "desc", prompt: "prompt" },
    });
    const created = await createRes.json();

    const deleteRes = await request.delete(`${BASE}/api/agent-skills/${created.id}`);
    expect(deleteRes.ok()).toBeTruthy();
    const body = await deleteRes.json();
    expect(body.success).toBe(true);

    const getRes = await request.get(`${BASE}/api/agent-skills/${created.id}`);
    expect(getRes.status()).toBe(404);
  });

  test("DELETE /api/agent-skills/:id returns 404 for unknown id", async ({ request }) => {
    const res = await request.delete(`${BASE}/api/agent-skills/00000000-0000-0000-0000-000000000000`);
    expect(res.status()).toBe(404);
  });

  test("DELETE /api/agent-skills/:id rejects deleting a built-in skill", async ({ request }) => {
    const listRes = await request.get(`${BASE}/api/agent-skills`);
    const skills = await listRes.json();
    const builtin = skills.find((s: { isBuiltin: boolean }) => s.isBuiltin);
    expect(builtin).toBeDefined();

    const res = await request.delete(`${BASE}/api/agent-skills/${builtin.id}`);
    expect(res.status()).toBe(403);
  });

  test("GET /api/agent-skills?projectId=<id> includes global and project-scoped skills", async ({ request }) => {
    const projectsRes = await request.get(`${BASE}/api/projects`);
    const projects = await projectsRes.json();
    const projectId = projects[0].id;

    const scopedRes = await request.post(`${BASE}/api/agent-skills`, {
      data: {
        name: `project-skill-${suffix}`,
        description: "Project-scoped skill",
        prompt: "Scoped prompt",
        projectId,
      },
    });
    expect(scopedRes.status()).toBe(201);
    const scoped = await scopedRes.json();
    createdIds.push(scoped.id);

    const listRes = await request.get(`${BASE}/api/agent-skills?projectId=${projectId}`);
    const list = await listRes.json();
    const scopedInList = list.find((s: { id: string }) => s.id === scoped.id);
    expect(scopedInList).toBeDefined();
    expect(scopedInList.projectId).toBe(projectId);

    // Global skills also returned
    for (const name of BUILTIN_SKILLS) {
      expect(list.some((s: { name: string }) => s.name === name)).toBeTruthy();
    }
  });
});
