import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { projects } from "@agentic-kanban/shared/schema";

const sdkMock = vi.hoisted(() => ({
  calls: [] as Array<{
    options: Record<string, unknown>;
    setModel: ReturnType<typeof vi.fn>;
    sessionId: string;
  }>,
  nextSessionNumber: 1,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ options }: { options: Record<string, unknown> }) => {
    const call = {
      options,
      setModel: vi.fn(async () => {}),
      sessionId: `sdk-session-${sdkMock.nextSessionNumber++}`,
    };
    sdkMock.calls.push(call);

    let yieldedInit = false;
    const abortSignal = (options.abortController as AbortController | undefined)?.signal;
    const iterator = {
      setModel: call.setModel,
      supportedCommands: vi.fn(async () => []),
      getContextUsage: vi.fn(async () => ({ totalTokens: 42, maxTokens: 200000 })),
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<Record<string, unknown>>> {
        if (!yieldedInit) {
          yieldedInit = true;
          return new Promise((resolve) => queueMicrotask(() => resolve({
            done: false,
            value: {
              type: "system",
              subtype: "init",
              session_id: call.sessionId,
              model: typeof options.model === "string" ? options.model : "sdk-default-model",
              mcp_servers: [{ name: "agentic-kanban", status: "connected" }],
            },
          })));
        }
        if (abortSignal?.aborted) {
          return { done: true, value: undefined as unknown as Record<string, unknown> };
        }
        return new Promise((resolve) => {
          abortSignal?.addEventListener(
            "abort",
            () => resolve({ done: true, value: undefined as unknown as Record<string, unknown> }),
            { once: true },
          );
        });
      },
    };

    return iterator;
  }),
}));

import { createButlerRoute } from "../routes/butler.js";
import { getPreference, setPreference } from "../repositories/preferences.repository.js";
import { ensureButlerSession, sendButlerTurn, stopButlerSession, isInvalidThinkingSignatureError, getButlerSession } from "../services/butler-sdk.service.js";
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

function butlerSessionPrefKey(projectId: string, butlerId = "default"): string {
  return `butler_session_${projectId}${butlerId === "default" ? "" : `__${butlerId}`}`;
}

function waitForCondition(description: string, condition: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - started > 1000) {
        reject(new Error(`Timed out waiting for ${description}`));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

function waitForQueryCalls(count: number): Promise<void> {
  return waitForCondition(`${count} SDK query calls, saw ${sdkMock.calls.length}`, () => sdkMock.calls.length >= count);
}

function waitForSessionId(projectId: string, sessionId: string): Promise<void> {
  return waitForCondition(`Butler session ${sessionId}`, () => getButlerSession(projectId).sessionId === sessionId);
}

describe("Butler provider selection", () => {
  const sessionsToStop: string[] = [];

  beforeEach(() => {
    sdkMock.calls.length = 0;
    sdkMock.nextSessionNumber = 1;
  });

  afterEach(() => {
    while (sessionsToStop.length > 0) {
      stopButlerSession(sessionsToStop.pop() as string);
    }
  });

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

  it("classifies the Anthropic invalid-thinking-signature 400 as recoverable", () => {
    // The real API error a resumed transcript with an unverifiable thinking block produces.
    expect(isInvalidThinkingSignatureError("messages.1.content.0: Invalid signature in thinking block")).toBe(true);
    expect(isInvalidThinkingSignatureError("400 messages.1.content.0: Invalid signature in thinking block")).toBe(true);
    // Unrelated errors must NOT be swallowed as resume failures.
    expect(isInvalidThinkingSignatureError("No conversation found with session ID: abc")).toBe(false);
    expect(isInvalidThinkingSignatureError("overloaded_error")).toBe(false);
  });

  it("starts cold Butler sessions fresh when no resume id is persisted", async () => {
    const { app, db } = createTestApp();
    const projectId = await createProject(db);
    sessionsToStop.push(projectId);

    const stateBefore = await app.request(`/api/projects/${projectId}/butler`);
    expect(stateBefore.status).toBe(200);
    expect(await stateBefore.json()).toMatchObject({
      active: false,
      sessionId: null,
      selectedModel: "",
      selectedProfile: "",
    });

    const res = await app.request(`/api/projects/${projectId}/butler/ensure`, {
      method: "POST",
      body: "{}",
    });

    expect(res.status).toBe(201);
    await waitForQueryCalls(1);
    expect(sdkMock.calls[0].options).not.toHaveProperty("resume");
  });

  it("resumes a persisted Butler session id instead of creating a new conversation", async () => {
    const { app, db } = createTestApp();
    const projectId = await createProject(db);
    sessionsToStop.push(projectId);
    await setPreference(butlerSessionPrefKey(projectId), "persisted-session-123", db);

    const coldState = await app.request(`/api/projects/${projectId}/butler`);
    expect(coldState.status).toBe(200);
    expect(await coldState.json()).toMatchObject({
      active: false,
      sessionId: "persisted-session-123",
    });

    const res = await app.request(`/api/projects/${projectId}/butler/ensure`, {
      method: "POST",
      body: "{}",
    });

    expect(res.status).toBe(201);
    await waitForQueryCalls(1);
    expect(sdkMock.calls[0].options.resume).toBe("persisted-session-123");
  });

  it("keeps displayed and running model/profile selections consistent across switches", async () => {
    const { app, db } = createTestApp();
    const projectId = await createProject(db);
    sessionsToStop.push(projectId);

    const ensureRes = await app.request(`/api/projects/${projectId}/butler/ensure`, {
      method: "POST",
      body: "{}",
    });
    expect(ensureRes.status).toBe(201);
    await waitForQueryCalls(1);
    await waitForSessionId(projectId, sdkMock.calls[0].sessionId);

    const opusRes = await app.request(`/api/projects/${projectId}/butler/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "opus" }),
    });
    expect(opusRes.status).toBe(200);
    expect(await opusRes.json()).toMatchObject({ ok: true, model: "opus", applied: true });
    expect(sdkMock.calls[0].setModel).toHaveBeenCalledWith("opus");

    const afterModel = await app.request(`/api/projects/${projectId}/butler`);
    expect(afterModel.status).toBe(200);
    expect(await afterModel.json()).toMatchObject({
      active: true,
      model: "opus",
      selectedModel: "opus",
      selectedProfile: "",
    });
    expect(getButlerSession(projectId)).toMatchObject({ model: "opus", claudeProfile: undefined });

    const profileRes = await app.request(`/api/projects/${projectId}/butler/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "mock" }),
    });
    expect(profileRes.status).toBe(200);
    expect(await profileRes.json()).toMatchObject({ ok: true, profile: "mock", active: true });
    await waitForQueryCalls(2);
    await waitForSessionId(projectId, sdkMock.calls[1].sessionId);

    expect(await getPreference(butlerSessionPrefKey(projectId), db)).toBe("");
    expect(sdkMock.calls[1].options).not.toHaveProperty("resume");
    expect(sdkMock.calls[1].options.model).toBe("opus");

    const afterProfile = await app.request(`/api/projects/${projectId}/butler`);
    expect(afterProfile.status).toBe(200);
    expect(await afterProfile.json()).toMatchObject({
      active: true,
      model: "opus",
      selectedModel: "opus",
      selectedProfile: "mock",
    });
    expect(getButlerSession(projectId)).toMatchObject({ model: "opus", claudeProfile: "mock" });

    const haikuRes = await app.request(`/api/projects/${projectId}/butler/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "haiku" }),
    });
    expect(haikuRes.status).toBe(200);
    expect(await haikuRes.json()).toMatchObject({ ok: true, model: "haiku", applied: true });
    expect(sdkMock.calls[1].setModel).toHaveBeenCalledWith("haiku");

    const finalState = await app.request(`/api/projects/${projectId}/butler`);
    expect(finalState.status).toBe(200);
    expect(await finalState.json()).toMatchObject({
      active: true,
      model: "haiku",
      selectedModel: "haiku",
      selectedProfile: "mock",
    });
    expect(getButlerSession(projectId)).toMatchObject({ model: "haiku", claudeProfile: "mock" });
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
