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
  "../../../shared/drizzle/0007_diff_comments.sql",
  "../../../shared/drizzle/0008_direct_workspace.sql",
  "../../../shared/drizzle/0009_requires_review.sql",
  "../../../shared/drizzle/0010_session_messages_cascade.sql",
  "../../../shared/drizzle/0011_timestamps.sql",
  "../../../shared/drizzle/0012_session_stats.sql",
  "../../../shared/drizzle/0013_plan_mode.sql",
  "../../../shared/drizzle/0014_issue_dependencies.sql",
  "../../../shared/drizzle/0015_ai_reviewed_status.sql",
  "../../../shared/drizzle/0016_skip_auto_review.sql",
  "../../../shared/drizzle/0017_agent_config.sql",
  "../../../shared/drizzle/0018_agent_skills.sql",
  "../../../shared/drizzle/0019_workspace_skill.sql",
  "../../../shared/drizzle/0023_dependency_types.sql",
  "../../../shared/drizzle/0020_setup_script.sql",
  "../../../shared/drizzle/0021_project_skills.sql",
  "../../../shared/drizzle/0022_teardown_script.sql",
  "../../../shared/drizzle/0024_setup_enabled.sql",
  "../../../shared/drizzle/0025_provider_session_id.sql",
  "../../../shared/drizzle/0026_ready_for_merge.sql",
  "../../../shared/drizzle/0027_estimate_field.sql",
  "../../../shared/drizzle/0028_perf_indexes_conflict_cache.sql",
  "../../../shared/drizzle/0029_issue_artifacts.sql",
  "../../../shared/drizzle/0030_thorough_review.sql",
  "../../../shared/drizzle/0031_scheduled_runs.sql",
  "../../../shared/drizzle/0032_diff_stat_cache.sql",
  "../../../shared/drizzle/0033_backlog_status.sql",
  "../../../shared/drizzle/0034_session_pid.sql",
  "../../../shared/drizzle/0035_session_trigger.sql",
  "../../../shared/drizzle/0036_scheduled_runs_cron.sql",
  "../../../shared/drizzle/0037_workspace_provider.sql",
  "../../../shared/drizzle/0038_pending_plan_path.sql",
  "../../../shared/drizzle/0039_nullable_default_branch.sql",
  "../../../shared/drizzle/0040_direct_workspace_base_commit.sql",
  "../../../shared/drizzle/0041_builtin_tags.sql",
  "../../../shared/drizzle/0042_issue_type.sql",
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

