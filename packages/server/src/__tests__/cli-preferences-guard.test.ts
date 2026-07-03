/**
 * #973 — CLI bypass of the #903 write-time provider-divergence guard.
 *
 * `pnpm cli -- preferences set <key> <value>` used to call the raw repository
 * `setPreference` for ANY key, so a single CLI call on `provider`/`*_profile`
 * could recreate the settings/Bullseye drift class that caused a documented
 * multi-cycle stall. Provider/profile keys must now go through the same
 * projection + loud rejection as `PUT /api/preferences/settings`; all other
 * keys keep the raw write (the CLI is deliberately a power tool for arbitrary
 * keys — cooldown stamps, dynamic per-project prefs, activeProjectId, …).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { setPreferences, getPreference } from "../repositories/preferences.repository.js";
import { setPreferenceGuarded } from "../cli/commands/preferences.js";

const now = new Date().toISOString();
const claudeBullseye = JSON.stringify({
  providerPolicies: [
    { id: "p1", provider: "claude", profileName: "anth", label: "Claude anth", mode: "fill", headroomPct: 0, notes: "" },
  ],
});

describe("CLI preferences set — provider-key divergence guard (#973)", () => {
  const { db: database } = createTestDb();
  let projectId: string;

  beforeEach(async () => {
    projectId = randomUUID();
    await database.insert(schema.projects).values({
      id: projectId,
      name: "cli-guard-test",
      repoPath: "/tmp/cli-guard-test",
      repoName: "cli-guard-test",
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

  it("rejects a claude_profile write that would diverge from the active project's Bullseye", async () => {
    const result = await setPreferenceGuarded("claude_profile", "work", database);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Bullseye/i);
    // Nothing persisted.
    expect(await getPreference("claude_profile", database)).toBe("anth");
  });

  it("rejects a provider write that would diverge from the active project's Bullseye", async () => {
    const result = await setPreferenceGuarded("provider", "codex", database);
    expect(result.ok).toBe(false);
    expect(await getPreference("provider", database)).toBe("claude");
  });

  it("allows a provider/profile write that AGREES with the Bullseye", async () => {
    const result = await setPreferenceGuarded("claude_profile", "anth", database);
    expect(result.ok).toBe(true);
    expect(await getPreference("claude_profile", database)).toBe("anth");
  });

  it("allows a provider write when no Bullseye is configured for the active project", async () => {
    await setPreferences([{ key: `board_strategy_${projectId}`, value: "" }], database);
    const result = await setPreferenceGuarded("provider", "codex", database);
    expect(result.ok).toBe(true);
    expect(await getPreference("provider", database)).toBe("codex");
  });

  it("keeps the raw unvalidated write for non-provider keys (arbitrary CLI power-tool keys)", async () => {
    const result = await setPreferenceGuarded("claude_cooldown_anth", "2030-01-01T00:00:00.000Z", database);
    expect(result.ok).toBe(true);
    expect(await getPreference("claude_cooldown_anth", database)).toBe("2030-01-01T00:00:00.000Z");

    // Even a key the settings whitelist would drop still writes raw (unchanged CLI contract).
    const arbitrary = await setPreferenceGuarded("some_totally_unregistered_key", "v", database);
    expect(arbitrary.ok).toBe(true);
    expect(await getPreference("some_totally_unregistered_key", database)).toBe("v");
  });
});
