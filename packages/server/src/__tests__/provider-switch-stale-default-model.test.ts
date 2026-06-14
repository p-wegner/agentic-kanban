/**
 * Regression test for the 2026-06-08 board-wide outage:
 * a leftover `default_model=gpt-5.5` (Codex model id) in preferences caused every
 * Claude launch to receive `--model gpt-5.5`, which made claude.exe exit immediately
 * with an invalid-model error (exit 1, ~0 tokens, "issue with selected model").
 *
 * Fix path: workspace-crud.service.ts `buildAgentConfig` calls `modelBelongsToProvider`
 * and drops any model id that doesn't match the active provider's family.
 * The test below verifies the full chain via the preview endpoint (read-only, no git ops).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createRoutes } from "../routes/index.js";
import * as schema from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { modelBelongsToProvider } from "@agentic-kanban/shared";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api", createRoutes(db, () => createMockSessionManager()));
  });
}

const now = new Date().toISOString();

describe("modelBelongsToProvider — stale default_model guard", () => {
  it("rejects a Codex gpt-5.5 model for the claude provider", () => {
    expect(modelBelongsToProvider("gpt-5.5", "claude")).toBe(false);
  });

  it("rejects other GPT model ids for the claude provider", () => {
    expect(modelBelongsToProvider("gpt-4o", "claude")).toBe(false);
    expect(modelBelongsToProvider("o1-preview", "claude")).toBe(false);
    expect(modelBelongsToProvider("o3-mini", "claude")).toBe(false);
  });

  it("accepts native Claude model ids for the claude provider", () => {
    expect(modelBelongsToProvider("claude-sonnet-4-6", "claude")).toBe(true);
    expect(modelBelongsToProvider("sonnet", "claude")).toBe(true);
    expect(modelBelongsToProvider("opus", "claude")).toBe(true);
    expect(modelBelongsToProvider("haiku", "claude")).toBe(true);
  });

  it("accepts an empty / unknown model id for any provider (unknown ids pass through)", () => {
    expect(modelBelongsToProvider("", "claude")).toBe(true);
    expect(modelBelongsToProvider(undefined, "claude")).toBe(true);
    expect(modelBelongsToProvider("custom-endpoint-model", "claude")).toBe(true);
  });

  it("rejects Claude model ids for the codex provider", () => {
    expect(modelBelongsToProvider("claude-sonnet-4-6", "codex")).toBe(false);
    expect(modelBelongsToProvider("sonnet", "codex")).toBe(false);
  });

  it("accepts GPT model ids for the codex provider", () => {
    expect(modelBelongsToProvider("gpt-5.5", "codex")).toBe(true);
    expect(modelBelongsToProvider("gpt-4o", "codex")).toBe(true);
  });

  it("accepts any model for the copilot provider (no --model flag)", () => {
    expect(modelBelongsToProvider("gpt-5.5", "copilot")).toBe(true);
    expect(modelBelongsToProvider("claude-sonnet-4-6", "copilot")).toBe(true);
  });

  it("rejects non-empty Pi models until Pi model families are finalized", () => {
    expect(modelBelongsToProvider("", "pi")).toBe(true);
    expect(modelBelongsToProvider(undefined, "pi")).toBe(true);
    expect(modelBelongsToProvider("gpt-5.5", "pi")).toBe(false);
    expect(modelBelongsToProvider("claude-sonnet-4-6", "pi")).toBe(false);
  });
});

describe("POST /api/workspaces/preview — stale Codex default_model is dropped for Claude provider", () => {
  const { app, db: database } = createTestApp();
  let projectId: string;
  let statusId: string;
  let issueId: string;

  beforeAll(async () => {
    // Seed a project, status, and issue to preview against
    projectId = randomUUID();
    await database.insert(schema.projects).values({
      id: projectId,
      name: "provider-switch-test",
      repoPath: "/tmp/provider-switch-test",
      repoName: "provider-switch-test",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });

    statusId = randomUUID();
    await database.insert(schema.projectStatuses).values({
      id: statusId,
      projectId,
      name: "Todo",
      sortOrder: 0,
      isDefault: true,
      createdAt: now,
    });

    issueId = randomUUID();
    await database.insert(schema.issues).values({
      id: issueId,
      projectId,
      statusId,
      issueNumber: 1,
      title: "Switch-provider regression test issue",
      description: "",
      priority: "medium",
      issueType: "task",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Simulate the stale-default scenario: default_model is set to a Codex model id,
    // provider and claude_profile are set to Claude ("anth").
    await database.insert(schema.preferences).values([
      { key: "provider", value: "claude" },
      { key: "claude_profile", value: "anth" },
      { key: "default_model", value: "gpt-5.5" },
    ]);
  });

  it("drops the stale Codex default_model and returns model=null for a Claude workspace", async () => {
    const res = await app.request("/api/workspaces/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issueId,
        branch: "feature/ak-1-provider-switch",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;

    // Provider must be claude
    expect(body.provider).toBe("claude");

    // The stale gpt-5.5 default_model must NOT appear — passing it to claude.exe
    // would trigger the invalid-model failure that caused the 2026-06-08 outage.
    expect(body.model).toBeNull();
  });

  it("uses an explicit claude-family model when provided, even with a stale default_model pref", async () => {
    const res = await app.request("/api/workspaces/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issueId,
        branch: "feature/ak-1-provider-switch-explicit",
        model: "sonnet",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.provider).toBe("claude");
    // An explicitly-requested Claude model must pass through
    expect(body.model).toBe("sonnet");
  });
});
