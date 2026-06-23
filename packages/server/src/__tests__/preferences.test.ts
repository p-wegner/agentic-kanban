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

  it("GET /api/preferences/active-project supports monitor-style value consumers", async () => {
    const id = randomUUID();
    await app.request("/api/preferences/active-project", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: id }),
    });

    const res = await app.request("/api/preferences/active-project");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.value).toBe(id);
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

  it("GET /api/preferences/settings returns Pi provider settings", async () => {
    const { app: freshApp } = createTestApp();

    await freshApp.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "pi",
        pi_profile: "local",
      }),
    });

    const res = await freshApp.request("/api/preferences/settings");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.provider).toBe("pi");
    expect(body.pi_profile).toBe("local");
  });


  it("PUT /api/preferences/settings rejects disallowed keys loudly (422) but persists the valid ones", async () => {
    const { app: freshApp } = createTestApp();

    const putRes = await freshApp.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_command: "test",
        malicious_key: "should be rejected",
      }),
    });

    // #874: an un-whitelisted key no longer silently no-ops — it fails loudly.
    expect(putRes.status).toBe(422);
    const putBody = await putRes.json() as any;
    expect(putBody.ok).toBe(false);
    expect(putBody.droppedKeys).toEqual(["malicious_key"]);
    expect(putBody.applied).toEqual(["agent_command"]);
    expect(putBody.error).toContain("malicious_key");

    // The valid key is still persisted (partial-apply), the rejected one is not.
    const res = await freshApp.request("/api/preferences/settings");
    const body = await res.json() as any;
    expect(body.agent_command).toBe("test");
    expect(body.malicious_key).toBeUndefined();
  });

  it("PUT /api/preferences/settings returns 200 + applied keys when all keys are valid", async () => {
    const { app: freshApp } = createTestApp();

    const putRes = await freshApp.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_command: "ok", claude_profile: "mock" }),
    });

    expect(putRes.status).toBe(200);
    const putBody = await putRes.json() as any;
    expect(putBody.ok).toBe(true);
    expect(putBody.applied).toEqual(expect.arrayContaining(["agent_command", "claude_profile"]));
    expect(putBody.droppedKeys).toBeUndefined();
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

  it("PUT /api/preferences/settings stores project-scoped backlog presets", async () => {
    const { app: freshApp } = createTestApp();
    const projectId = randomUUID();
    const key = `backlog_filter_presets_${projectId}`;
    const value = JSON.stringify([{ id: "preset-1", name: "High bugs" }]);

    await freshApp.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    });

    const res = await freshApp.request("/api/preferences/settings");
    const body = await res.json() as any;
    expect(body[key]).toBe(value);
  });

  it("PUT /api/preferences/settings stores project-scoped board saved views", async () => {
    const { app: freshApp } = createTestApp();
    const projectId = randomUUID();
    const key = `board_saved_views_${projectId}`;
    const value = JSON.stringify([{ id: "view-1", name: "Review queue", state: { searchQuery: "review" } }]);

    await freshApp.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    });

    const res = await freshApp.request("/api/preferences/settings");
    const body = await res.json() as any;
    expect(body[key]).toBe(value);
  });

  it("PUT /api/preferences/settings stores project-scoped launch templates", async () => {
    const { app: freshApp } = createTestApp();
    const projectId = randomUUID();
    const key = `launch_templates_${projectId}`;
    const value = JSON.stringify([{ id: "lt-1", name: "Standard", options: { planMode: true } }]);

    await freshApp.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    });

    const res = await freshApp.request("/api/preferences/settings");
    const body = await res.json() as any;
    expect(body[key]).toBe(value);
  });

  it("PUT /api/preferences/settings stores project-scoped agent presets", async () => {
    const { app: freshApp } = createTestApp();
    const projectId = randomUUID();
    const key = `agent_presets_${projectId}`;
    const value = JSON.stringify([{ id: "ap-1", name: "Claude Opus", provider: "claude", model: "opus", createdAt: "", updatedAt: "" }]);

    await freshApp.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    });

    const res = await freshApp.request("/api/preferences/settings");
    const body = await res.json() as any;
    expect(body[key]).toBe(value);
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
        pi_profile: "local",
        copilot_profile: "gpt-5.2",
      }),
    });

    const res = await freshApp.request("/api/preferences/settings");
    const body = await res.json() as any;
    expect(body.agent_command).toBe("custom-agent");
    expect(body.agent_args).toBe("--flag value");
    expect(body.output_parser).toBe("custom");
    expect(body.claude_profile).toBe("mock");
    expect(body.pi_profile).toBe("local");
    expect(body.copilot_profile).toBe("gpt-5.2");
  });

  it("GET /api/preferences/copilot-profiles returns the default profile", async () => {
    const { app: freshApp } = createTestApp();
    const res = await freshApp.request("/api/preferences/copilot-profiles");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.profiles).toEqual(["default"]);
  });

  it("GET /api/preferences/agent-profiles/health maps configured profiles to preflight rows", async () => {
    const { app: freshApp } = createTestApp();
    await freshApp.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "codex",
        codex_profile: "default",
        agent_args: "--model test-model --api-key should-not-render",
      }),
    });

    const res = await freshApp.request("/api/preferences/agent-profiles/health");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const codex = body.profiles.find((profile: any) => profile.id === "codex:default");
    expect(codex).toMatchObject({
      provider: "codex",
      profileName: "default",
      selected: true,
    });
    expect(codex.preflight.flags).toContain("--model test-model");
    expect(codex.preflight.flags).toContain("--api-key [redacted]");
    expect(JSON.stringify(codex)).not.toContain("should-not-render");
  });

  it("POST /api/preferences/agent-profiles/preflight reports missing profile config shape", async () => {
    const { app: freshApp } = createTestApp();
    const res = await freshApp.request("/api/preferences/agent-profiles/preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "codex", profileName: "missing-profile-for-test" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.errors[0]).toContain("Profile config not found");
    expect(body.errors[0]).toContain("missing-profile-for-test");
  });
});

