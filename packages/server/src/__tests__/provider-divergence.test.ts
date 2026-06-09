/**
 * Tests for the single-source-of-truth provider/profile resolution (#706).
 *
 * Verifies that:
 * 1. getProviderDivergence() correctly detects when global settings prefs differ
 *    from the project's Strategy Bullseye.
 * 2. getProviderDivergence() returns diverged=false when no Bullseye is configured.
 * 3. selectProviderFromStrategy() returns the expected provider/profile from a
 *    Bullseye config (used by both buildAgentConfig and resolveButlerBackend).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createRoutes } from "../routes/index.js";
import * as schema from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import {
  parseStrategyBullseyeConfig,
  selectProviderFromStrategy,
} from "../services/strategy-objective.service.js";
import { createPreferenceService } from "../services/preference.service.js";
import { setPreferences } from "../repositories/preferences.repository.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api", createRoutes(db, () => createMockSessionManager()));
  });
}

const now = new Date().toISOString();

// ---------------------------------------------------------------------------
// Unit tests for selectProviderFromStrategy (Bullseye → provider/profile)
// ---------------------------------------------------------------------------

describe("selectProviderFromStrategy — Bullseye provider resolution", () => {
  it("returns fill policy provider+profile when a fill policy exists", () => {
    const config = parseStrategyBullseyeConfig(JSON.stringify({
      providerPolicies: [
        { id: "p1", provider: "claude", profileName: "anth", label: "Claude", mode: "fill", headroomPct: 0, notes: "" },
        { id: "p2", provider: "codex", profileName: "default", label: "Codex", mode: "fallback-only", headroomPct: 0, notes: "" },
      ],
    }));
    const selected = selectProviderFromStrategy(config);
    expect(selected?.provider).toBe("claude");
    expect(selected?.profileName).toBe("anth");
  });

  it("falls through to throttle when no fill policy", () => {
    const config = parseStrategyBullseyeConfig(JSON.stringify({
      providerPolicies: [
        { id: "p1", provider: "codex", profileName: "ki14", label: "Codex", mode: "throttle", headroomPct: 20, notes: "" },
      ],
    }));
    const selected = selectProviderFromStrategy(config);
    expect(selected?.provider).toBe("codex");
    expect(selected?.profileName).toBe("ki14");
  });

  it("returns null when providerPolicies is empty", () => {
    const config = parseStrategyBullseyeConfig(JSON.stringify({ providerPolicies: [] }));
    expect(selectProviderFromStrategy(config)).toBeNull();
  });

  it("does not return fallback-only without allowFallback=true", () => {
    const config = parseStrategyBullseyeConfig(JSON.stringify({
      providerPolicies: [
        { id: "p1", provider: "claude", profileName: "anth", label: "Claude", mode: "fallback-only", headroomPct: 0, notes: "" },
      ],
    }));
    expect(selectProviderFromStrategy(config)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration tests: getProviderDivergence — no bullseye
// ---------------------------------------------------------------------------

describe("getProviderDivergence — no Bullseye configured", () => {
  const { db: database } = createTestApp();
  let projectId: string;

  beforeAll(async () => {
    projectId = randomUUID();
    await database.insert(schema.projects).values({
      id: projectId,
      name: "divergence-no-bullseye",
      repoPath: "/tmp/divergence-no-bullseye",
      repoName: "divergence-no-bullseye",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
  });

  it("returns hasBullseye=false and diverged=false when no Bullseye is set", async () => {
    const svc = createPreferenceService({ database });
    const result = await svc.getProviderDivergence(projectId);
    expect(result.hasBullseye).toBe(false);
    expect(result.diverged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: getProviderDivergence — matching (no divergence)
// ---------------------------------------------------------------------------

describe("getProviderDivergence — Bullseye and settings agree", () => {
  const { db: database } = createTestApp();
  let projectId: string;

  beforeAll(async () => {
    projectId = randomUUID();
    await database.insert(schema.projects).values({
      id: projectId,
      name: "divergence-agree",
      repoPath: "/tmp/divergence-agree",
      repoName: "divergence-agree",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
    const bullseye = JSON.stringify({
      providerPolicies: [
        { id: "p1", provider: "claude", profileName: "anth", label: "Claude anth", mode: "fill", headroomPct: 0, notes: "" },
      ],
    });
    await setPreferences([
      { key: `board_strategy_${projectId}`, value: bullseye },
      { key: "provider", value: "claude" },
      { key: "claude_profile", value: "anth" },
    ], database);
  });

  it("returns diverged=false when Bullseye and global prefs agree (claude:anth)", async () => {
    const svc = createPreferenceService({ database });
    const result = await svc.getProviderDivergence(projectId);
    expect(result.hasBullseye).toBe(true);
    expect(result.bullseyeProvider).toBe("claude");
    expect(result.bullseyeProfile).toBe("anth");
    expect(result.settingsProvider).toBe("claude");
    expect(result.settingsProfile).toBe("anth");
    expect(result.diverged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: getProviderDivergence — provider mismatch
// ---------------------------------------------------------------------------

describe("getProviderDivergence — provider mismatch (Bullseye=claude, settings=codex)", () => {
  const { db: database } = createTestApp();
  let projectId: string;

  beforeAll(async () => {
    projectId = randomUUID();
    await database.insert(schema.projects).values({
      id: projectId,
      name: "divergence-provider-mismatch",
      repoPath: "/tmp/divergence-provider-mismatch",
      repoName: "divergence-provider-mismatch",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
    const bullseye = JSON.stringify({
      providerPolicies: [
        { id: "p1", provider: "claude", profileName: "anth", label: "Claude anth", mode: "fill", headroomPct: 0, notes: "" },
      ],
    });
    await setPreferences([
      { key: `board_strategy_${projectId}`, value: bullseye },
      { key: "provider", value: "codex" },
      { key: "codex_profile", value: "default" },
    ], database);
  });

  it("returns diverged=true when global provider differs from Bullseye", async () => {
    const svc = createPreferenceService({ database });
    const result = await svc.getProviderDivergence(projectId);
    expect(result.hasBullseye).toBe(true);
    expect(result.bullseyeProvider).toBe("claude");
    expect(result.settingsProvider).toBe("codex");
    expect(result.diverged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: getProviderDivergence — profile mismatch
// ---------------------------------------------------------------------------

describe("getProviderDivergence — profile mismatch (Bullseye=claude:anth, settings=claude:work)", () => {
  const { db: database } = createTestApp();
  let projectId: string;

  beforeAll(async () => {
    projectId = randomUUID();
    await database.insert(schema.projects).values({
      id: projectId,
      name: "divergence-profile-mismatch",
      repoPath: "/tmp/divergence-profile-mismatch",
      repoName: "divergence-profile-mismatch",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
    const bullseye = JSON.stringify({
      providerPolicies: [
        { id: "p1", provider: "claude", profileName: "anth", label: "Claude anth", mode: "fill", headroomPct: 0, notes: "" },
      ],
    });
    await setPreferences([
      { key: `board_strategy_${projectId}`, value: bullseye },
      { key: "provider", value: "claude" },
      { key: "claude_profile", value: "work" },
    ], database);
  });

  it("returns diverged=true when provider matches but profile differs", async () => {
    const svc = createPreferenceService({ database });
    const result = await svc.getProviderDivergence(projectId);
    expect(result.hasBullseye).toBe(true);
    expect(result.bullseyeProvider).toBe("claude");
    expect(result.bullseyeProfile).toBe("anth");
    expect(result.settingsProvider).toBe("claude");
    expect(result.settingsProfile).toBe("work");
    expect(result.diverged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// API endpoint: GET /api/preferences/provider-divergence?projectId=
// ---------------------------------------------------------------------------

describe("GET /api/preferences/provider-divergence", () => {
  const { app, db: database } = createTestApp();
  let projectId: string;

  beforeAll(async () => {
    projectId = randomUUID();
    await database.insert(schema.projects).values({
      id: projectId,
      name: "divergence-api-test",
      repoPath: "/tmp/divergence-api-test",
      repoName: "divergence-api-test",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
  });

  it("returns hasBullseye=false for a project with no Bullseye", async () => {
    const res = await app.request(`/api/preferences/provider-divergence?projectId=${projectId}`, { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.hasBullseye).toBe(false);
    expect(body.diverged).toBe(false);
  });

  it("returns 200 with diverged=false when projectId is omitted", async () => {
    const res = await app.request("/api/preferences/provider-divergence", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.hasBullseye).toBe(false);
    expect(body.diverged).toBe(false);
  });
});
