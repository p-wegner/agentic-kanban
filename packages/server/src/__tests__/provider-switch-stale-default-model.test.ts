/**
 * Regression test for the 2026-06-08 board-wide outage:
 * a leftover `default_model=gpt-5.5` (Codex model id) in preferences caused every
 * Claude launch to receive `--model gpt-5.5`, which made claude.exe exit immediately
 * with an invalid-model error (exit 1, ~0 tokens, "issue with selected model").
 *
 * Original fix (#696): `modelBelongsToProvider` SILENTLY nullified a wrong-provider model.
 * Structural fix (#902): the global, provider-agnostic `default_model` key is RETIRED —
 * the resolver no longer reads it at all, so a cross-provider model is unrepresentable.
 * A leftover global key therefore has no effect on the preview below (it is ignored, not
 * nullified). `modelBelongsToProvider` is kept as the guard for an untrusted *requested*
 * model and its unit contract is still asserted here.
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

  it("accepts Pi models because Pi profiles select the concrete upstream provider", () => {
    expect(modelBelongsToProvider("", "pi")).toBe(true);
    expect(modelBelongsToProvider(undefined, "pi")).toBe(true);
    expect(modelBelongsToProvider("gpt-5.5", "pi")).toBe(true);
    expect(modelBelongsToProvider("claude-sonnet-4-6", "pi")).toBe(true);
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

    // Simulate the stale-default scenario: a leftover GLOBAL default_model is a Codex id,
    // provider and claude_profile are set to Claude ("anth"). Post-#902 the global key is
    // never read, so it must have NO effect on the resolved model.
    await database.insert(schema.preferences).values([
      { key: "provider", value: "claude" },
      { key: "claude_profile", value: "anth" },
      { key: "default_model", value: "gpt-5.5" },
    ]);
  });

  it("ignores the retired global default_model and returns model=null for a Claude workspace", async () => {
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
