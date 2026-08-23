import { describe, it, expect } from "vitest";

import { randomUUID } from "node:crypto";

import {
  createTestApp,
  createProjectDirectly,
} from "./helpers/api-test-helpers.js";

describe("Agent Skills API", () => {
  const { app, db: database } = createTestApp();

  it("POST /api/agent-skills creates a skill", async () => {
    const res = await app.request("/api/agent-skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-skill",
        description: "A test skill",
        prompt: "You are a test agent. Do X, Y, Z.",
        model: "haiku",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.name).toBe("test-skill");
    expect(body.description).toBe("A test skill");
    expect(body.prompt).toBe("You are a test agent. Do X, Y, Z.");
    expect(body.model).toBe("haiku");
    expect(body.isBuiltin).toBe(false);
  });

  it("GET /api/agent-skills lists all skills", async () => {
    const res = await app.request("/api/agent-skills");
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(body.length).toBeGreaterThanOrEqual(1);
    const names = body.map((s: any) => s.name);
    expect(names).toContain("test-skill");
  });

  it("GET /api/agent-skills/:id returns a skill", async () => {
    const listRes = await app.request("/api/agent-skills");
    const skills = await listRes.json() as any[];
    const skill = skills.find((s: any) => s.name === "test-skill");

    const res = await app.request(`/api/agent-skills/${skill.id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.id).toBe(skill.id);
    expect(body.prompt).toBe("You are a test agent. Do X, Y, Z.");
  });

  it("POST /api/agent-skills rejects duplicate name", async () => {
    const res = await app.request("/api/agent-skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-skill",
        description: "Duplicate",
        prompt: "dup",
      }),
    });
    expect(res.status).toBe(409);
  });

  it("POST /api/agent-skills validates required fields", async () => {
    const res = await app.request("/api/agent-skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "incomplete" }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT /api/agent-skills/:id updates a skill", async () => {
    const listRes = await app.request("/api/agent-skills");
    const skills = await listRes.json() as any[];
    const skill = skills.find((s: any) => s.name === "test-skill");

    const res = await app.request(`/api/agent-skills/${skill.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Updated description" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.description).toBe("Updated description");
  });

  it("DELETE /api/agent-skills/:id deletes a skill", async () => {
    // Create a skill to delete
    const createRes = await app.request("/api/agent-skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "to-delete",
        description: "Will be deleted",
        prompt: "delete me",
      }),
    });
    const { id } = await createRes.json() as any;

    const res = await app.request(`/api/agent-skills/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const getRes = await app.request(`/api/agent-skills/${id}`);
    expect(getRes.status).toBe(404);
  });

  it("protects builtin skills from modification", async () => {
    // Create a builtin skill directly in DB
    const { app: app2, db: database } = createTestApp();
    const { agentSkills } = await import("@agentic-kanban/shared/schema");
    const now = new Date().toISOString();
    await database.insert(agentSkills).values({
      id: randomUUID(),
      name: "builtin-skill",
      description: "Builtin",
      prompt: "builtin prompt",
      isBuiltin: true,
      createdAt: now,
      updatedAt: now,
    });

    const listRes = await app2.request("/api/agent-skills");
    const skills = await listRes.json() as any[];
    const builtin = skills.find((s: any) => s.name === "builtin-skill");

    // PUT should fail
    const putRes = await app2.request(`/api/agent-skills/${builtin.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "hacked" }),
    });
    expect(putRes.status).toBe(403);

    // DELETE should fail
    const delRes = await app2.request(`/api/agent-skills/${builtin.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(403);
  });

  it("POST /api/agent-skills accepts isInit and PUT can toggle it", async () => {
    const createRes = await app.request("/api/agent-skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "init-skill",
        description: "An init-only skill",
        prompt: "onboard the project",
        isInit: true,
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as any;
    expect(created.isInit).toBe(true);

    const putRes = await app.request(`/api/agent-skills/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isInit: false }),
    });
    expect(putRes.status).toBe(200);
    const updated = await putRes.json() as any;
    expect(updated.isInit).toBe(false);
  });

  it("GET /api/agent-skills?init=true filters to init skills only, merging global + project scope", async () => {
    // The project must live in the SAME database this suite's `app` serves. It used to be
    // created in a second, throwaway app — invisible to `app`, so the project-scoped POST
    // below hit a FOREIGN KEY failure. That went unnoticed because the request sent
    // `projectId: undefined` (a `.id` on a bare id string), which made the skill global and
    // the assertion pass for the wrong reason.
    const project = await createProjectDirectly(database, { name: "init-filter-project" });

    await app.request("/api/agent-skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "global-init", description: "d", prompt: "p", isInit: true }),
    });
    await app.request("/api/agent-skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "global-non-init", description: "d", prompt: "p", isInit: false }),
    });
    await app.request("/api/agent-skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "project-init", description: "d", prompt: "p", isInit: true, projectId: project }),
    });

    const res = await app.request(`/api/agent-skills?projectId=${project}&init=true`);
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    const names = body.map((s) => s.name);
    expect(names).toContain("global-init");
    expect(names).toContain("project-init");
    expect(names).not.toContain("global-non-init");
    expect(body.every((s) => s.isInit === true)).toBe(true);
  });
});

