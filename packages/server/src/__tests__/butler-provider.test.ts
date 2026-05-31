import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { projects } from "@agentic-kanban/shared/schema";
import { createButlerRoute } from "../routes/butler.js";
import { setPreference } from "../repositories/preferences.repository.js";
import { ensureButlerSession, sendButlerTurn, stopButlerSession } from "../services/butler-sdk.service.js";
import { MOCK_AGENT_COMMAND } from "../services/agent-settings.service.js";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import type { TestDb } from "./helpers/test-db.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api/projects", createButlerRoute(db, () => createMockSessionManager()));
  });
}

async function createProject(db: TestDb): Promise<string> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(projects).values({
    id,
    name: "Butler Test",
    repoPath: process.cwd(),
    repoName: "agentic-kanban",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe("Butler provider selection", () => {
  it("defaults to the Claude backend for existing Butler behavior", async () => {
    const { app, db } = createTestApp();
    const projectId = await createProject(db);

    const res = await app.request(`/api/projects/${projectId}/butler`);
    expect(res.status).toBe(200);
    const body = await res.json() as { backend: string; active: boolean };
    expect(body.backend).toBe("claude");
    expect(body.active).toBe(false);
  });

  it("uses Codex profiles and starts a logical Codex Butler when provider is Codex", async () => {
    const { app, db } = createTestApp();
    const projectId = await createProject(db);
    await setPreference("provider", "codex", db);
    await setPreference("codex_profile", "default", db);

    const profilesRes = await app.request(`/api/projects/${projectId}/butler/profiles`);
    expect(profilesRes.status).toBe(200);
    const profiles = await profilesRes.json() as { provider: string; selected: string; profiles: string[] };
    expect(profiles.provider).toBe("codex");
    expect(profiles.selected).toBe("default");
    expect(profiles.profiles).toContain("default");

    const ensureRes = await app.request(`/api/projects/${projectId}/butler/ensure`, {
      method: "POST",
      body: "{}",
    });
    expect(ensureRes.status).toBe(201);

    const stateRes = await app.request(`/api/projects/${projectId}/butler`);
    const state = await stateRes.json() as { backend: string; active: boolean };
    expect(state.backend).toBe("codex");
    expect(state.active).toBe(true);

    stopButlerSession(projectId);
  });

  it("does not apply saved Claude model aliases to a Codex Butler", async () => {
    const { app, db } = createTestApp();
    const projectId = await createProject(db);
    await setPreference("provider", "codex", db);
    await setPreference("codex_profile", "default", db);
    await setPreference("butler_definitions", JSON.stringify([{ id: "default", name: "Butler", model: "sonnet" }]), db);

    const stateRes = await app.request(`/api/projects/${projectId}/butler`);
    expect(stateRes.status).toBe(200);
    const state = await stateRes.json() as { selectedModel: string };
    expect(state.selectedModel).toBe("");

    const ensureRes = await app.request(`/api/projects/${projectId}/butler/ensure`, {
      method: "POST",
      body: "{}",
    });
    expect(ensureRes.status).toBe(201);

    const activeRes = await app.request(`/api/projects/${projectId}/butler`);
    const active = await activeRes.json() as { model?: string };
    expect(active.model).toBeUndefined();

    stopButlerSession(projectId);
  });

  it("rejects overlapping Codex Butler turns instead of enqueueing ambiguous prompts", () => {
    const projectId = randomUUID();
    ensureButlerSession({
      projectId,
      butlerId: "busy-test",
      repoPath: process.cwd(),
      projectName: "Butler Test",
      backend: "codex",
      agentCommand: MOCK_AGENT_COMMAND,
    });

    try {
      expect(sendButlerTurn(projectId, "first", { butlerId: "busy-test" })).toBe(true);
      expect(sendButlerTurn(projectId, "second", { butlerId: "busy-test" })).toBe(false);
    } finally {
      stopButlerSession(projectId, "busy-test");
    }
  });
});
