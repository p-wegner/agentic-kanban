import { describe, it, expect } from "vitest";
import { createPreferencesRoute } from "../routes/preferences.js";
import { randomUUID } from "node:crypto";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api/preferences", createPreferencesRoute(db));
  });
}

describe("Preferences API - active-project", () => {
  const { app } = createTestApp();

  it("GET /api/preferences/active-project returns null initially", async () => {
    const res = await app.request("/api/preferences/active-project");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.projectId).toBeNull();
  });

  it("PUT /api/preferences/active-project sets active project", async () => {
    const id = randomUUID();
    const res = await app.request("/api/preferences/active-project", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.projectId).toBe(id);
  });

  it("GET /api/preferences/active-project returns the set value", async () => {
    const id = randomUUID();
    await app.request("/api/preferences/active-project", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: id }),
    });

    const res = await app.request("/api/preferences/active-project");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.projectId).toBe(id);
  });

  it("PUT upserts the active-project preference", async () => {
    const id1 = randomUUID();
    const id2 = randomUUID();

    await app.request("/api/preferences/active-project", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: id1 }),
    });

    await app.request("/api/preferences/active-project", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: id2 }),
    });

    const res = await app.request("/api/preferences/active-project");
    const body = await res.json() as any;
    expect(body.projectId).toBe(id2);
  });

  it("PUT handles null projectId", async () => {
    // Set a value first
    const id = randomUUID();
    await app.request("/api/preferences/active-project", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: id }),
    });

    // Overwrite with null
    const res = await app.request("/api/preferences/active-project", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: null }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // The route stores body.projectId which is null, but returns it as-is
    expect(body.projectId).toBeNull();
  });
});

describe("Preferences API - settings", () => {
  const { app } = createTestApp();

  it("GET /api/preferences/settings returns empty defaults initially", async () => {
    const res = await app.request("/api/preferences/settings");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // No settings have been set yet, so all are absent
    expect(body).toEqual({});
  });

  it("PUT /api/preferences/settings sets allowed keys", async () => {
    const res = await app.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_command: "claude",
        agent_args: "--verbose",
        output_parser: "stream-json",
        claude_profile: "",
        copilot_profile: "gpt-5.2",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
  });

  it("GET /api/preferences/settings returns saved values", async () => {
    const { app: freshApp } = createTestApp();

    await freshApp.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_command: "my-agent",
        claude_profile: "mock",
      }),
    });

    const res = await freshApp.request("/api/preferences/settings");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.agent_command).toBe("my-agent");
    expect(body.claude_profile).toBe("mock");
    // agent_args and output_parser were not set
    expect(body.agent_args).toBeUndefined();
    expect(body.output_parser).toBeUndefined();
  });

  it("GET /api/preferences/settings returns Copilot provider settings", async () => {
    const { app: freshApp } = createTestApp();

    await freshApp.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "copilot",
        copilot_profile: "agent:reviewer",
      }),
    });

    const res = await freshApp.request("/api/preferences/settings");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.provider).toBe("copilot");
    expect(body.copilot_profile).toBe("agent:reviewer");
  });

  it("PUT /api/preferences/settings ignores disallowed keys", async () => {
    const { app: freshApp } = createTestApp();

    await freshApp.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_command: "test",
        malicious_key: "should be ignored",
      }),
    });

    const res = await freshApp.request("/api/preferences/settings");
    const body = await res.json() as any;
    expect(body.agent_command).toBe("test");
    // The malicious key should not have been persisted
    expect(body.malicious_key).toBeUndefined();
  });

  it("PUT /api/preferences/settings upserts existing values", async () => {
    const { app: freshApp } = createTestApp();

    // Set initial value
    await freshApp.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_command: "first" }),
    });

    // Update to new value
    await freshApp.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_command: "second" }),
    });

    const res = await freshApp.request("/api/preferences/settings");
    const body = await res.json() as any;
    expect(body.agent_command).toBe("second");
  });

  it("PUT /api/preferences/settings handles agent/profile allowed keys", async () => {
    const { app: freshApp } = createTestApp();

    await freshApp.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_command: "custom-agent",
        agent_args: "--flag value",
        output_parser: "custom",
        claude_profile: "mock",
        copilot_profile: "gpt-5.2",
      }),
    });

    const res = await freshApp.request("/api/preferences/settings");
    const body = await res.json() as any;
    expect(body.agent_command).toBe("custom-agent");
    expect(body.agent_args).toBe("--flag value");
    expect(body.output_parser).toBe("custom");
    expect(body.claude_profile).toBe("mock");
    expect(body.copilot_profile).toBe("gpt-5.2");
  });

  it("GET /api/preferences/copilot-profiles returns an empty profile list", async () => {
    const { app: freshApp } = createTestApp();
    const res = await freshApp.request("/api/preferences/copilot-profiles");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.profiles).toEqual([]);
  });
});

