import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { createPreferencesRoute } from "../routes/preferences.js";
import * as schema from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILES = [
  "../../../shared/drizzle/0000_flawless_trauma.sql",
  "../../../shared/drizzle/0001_magical_johnny_storm.sql",
  "../../../shared/drizzle/0002_bent_may_parker.sql",
  "../../../shared/drizzle/0003_tough_lightspeed.sql",
  "../../../shared/drizzle/0004_boring_wind_dancer.sql",
  "../../../shared/drizzle/0005_silky_frog_thor.sql",
  "../../../shared/drizzle/0006_wide_ogun.sql",
  "../../../shared/drizzle/0022_teardown_script.sql",
  "../../../shared/drizzle/0024_setup_enabled.sql",
];

function createTestApp() {
  const client = createClient({ url: ":memory:" });
  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(resolve(__dirname, file), "utf-8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      client.execute(stmt);
    }
  }

  const database = drizzle(client, { schema });
  const app = new Hono();
  app.route("/api/preferences", createPreferencesRoute(database));
  return { app, db: database };
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
        mock_agent: "0",
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
        mock_agent: "1",
      }),
    });

    const res = await freshApp.request("/api/preferences/settings");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.agent_command).toBe("my-agent");
    expect(body.mock_agent).toBe("1");
    // agent_args and output_parser were not set
    expect(body.agent_args).toBeUndefined();
    expect(body.output_parser).toBeUndefined();
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

  it("PUT /api/preferences/settings handles all four allowed keys", async () => {
    const { app: freshApp } = createTestApp();

    await freshApp.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_command: "custom-agent",
        agent_args: "--flag value",
        output_parser: "custom",
        mock_agent: "1",
      }),
    });

    const res = await freshApp.request("/api/preferences/settings");
    const body = await res.json() as any;
    expect(body.agent_command).toBe("custom-agent");
    expect(body.agent_args).toBe("--flag value");
    expect(body.output_parser).toBe("custom");
    expect(body.mock_agent).toBe("1");
  });
});
