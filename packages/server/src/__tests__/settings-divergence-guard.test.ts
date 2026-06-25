/**
 * Write-time provider/Bullseye divergence guard (#903).
 *
 * PUT /api/preferences/settings must REJECT (422, nothing persisted) a provider/profile
 * write that would put the global settings prefs out of sync with the ACTIVE project's
 * Strategy Bullseye — turning the old passive divergence banner into an enforced
 * invariant (retiring the set-provider-default skill's reason to exist).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createRoutes } from "../routes/index.js";
import * as schema from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import { createPreferenceService } from "../services/preference.service.js";
import { setPreferences, getPreference } from "../repositories/preferences.repository.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api", createRoutes(db, () => createMockSessionManager()));
  });
}

const now = new Date().toISOString();
const claudeBullseye = JSON.stringify({
  providerPolicies: [
    { id: "p1", provider: "claude", profileName: "anth", label: "Claude anth", mode: "fill", headroomPct: 0, notes: "" },
  ],
});

describe("PUT /api/preferences/settings — write-time divergence guard", () => {
  const { app, db: database } = createTestApp();
  let projectId: string;

  beforeEach(async () => {
    projectId = randomUUID();
    await database.insert(schema.projects).values({
      id: projectId,
      name: "guard-test",
      repoPath: "/tmp/guard-test",
      repoName: "guard-test",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
    await setPreferences([
      { key: "activeProjectId", value: projectId },
      { key: `board_strategy_${projectId}`, value: claudeBullseye },
      { key: "provider", value: "claude" },
      { key: "claude_profile", value: "anth" },
    ], database);
  });

  it("rejects a provider write that would diverge from the active project's Bullseye", async () => {
    const res = await app.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "codex", codex_profile: "default" }),
    });
    expect(res.status).toBe(422);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.divergence?.bullseyeProvider).toBe("claude");
    expect(body.divergence?.settingsProvider).toBe("codex");

    // NOTHING was persisted — provider pref is unchanged.
    expect(await getPreference("provider", database)).toBe("claude");
    expect(await getPreference("codex_profile", database)).toBeFalsy();
  });

  it("rejects a profile write that would diverge (same provider, different profile)", async () => {
    const res = await app.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claude_profile: "work" }),
    });
    expect(res.status).toBe(422);
    expect(await getPreference("claude_profile", database)).toBe("anth");
  });

  it("allows a provider write that AGREES with the Bullseye", async () => {
    // Re-assert the matching provider/profile — no divergence, write applies.
    const res = await app.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "claude", claude_profile: "anth" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
  });

  it("allows an UNRELATED settings write even when a pre-existing untouched drift exists", async () => {
    // Pre-existing drift: settings already say codex but Bullseye is claude. A write
    // that doesn't touch provider/profile keys must NOT be blocked by it.
    await setPreferences([
      { key: "provider", value: "codex" },
      { key: "codex_profile", value: "default" },
    ], database);

    const res = await app.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto_review: "false" }),
    });
    expect(res.status).toBe(200);
    expect(await getPreference("auto_review", database)).toBe("false");
  });

  it("allows a provider write when there is no Bullseye for the active project", async () => {
    await setPreferences([{ key: `board_strategy_${projectId}`, value: "" }], database);
    const res = await app.request("/api/preferences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "codex", codex_profile: "default" }),
    });
    expect(res.status).toBe(200);
    expect(await getPreference("provider", database)).toBe("codex");
  });
});
