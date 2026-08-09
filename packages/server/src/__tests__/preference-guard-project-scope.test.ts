/**
 * #335 (remedy R6) — the #903 provider-divergence guard must not be scoped by the
 * global mutable `activeProjectId`.
 *
 * `provider` / `*_profile` are GLOBAL preferences; a Strategy Bullseye is
 * per-project. The guard used to compare the global write against
 * `board_strategy_<activeProjectId>`, so the IDENTICAL write was accepted or
 * 422-rejected depending on which unrelated project a human had last clicked in the
 * UI switcher — and could be rejected because of a Bullseye belonging to a project
 * the caller never mentioned.
 *
 * The scoping is now derived from the WRITE, not from the switcher:
 *   - a write that carries `board_strategy_<id>` entries is gated against exactly
 *     those projects (the write declares which Bullseye is authoritative), and
 *   - a write that names no project is gated against every live project holding a
 *     Bullseye, but only when those agree on one provider/profile target — several
 *     projects demanding different providers make the invariant unsatisfiable, and
 *     an unsatisfiable invariant must not block every provider write.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { setPreferenceChecked } from "@agentic-kanban/shared/lib/checked-preference-write";
import { createTestDb } from "./helpers/test-db.js";

const now = new Date().toISOString();

function bullseye(provider: string, profileName: string): string {
  return JSON.stringify({
    providerPolicies: [
      { id: `${provider}:${profileName}`, provider, profileName, label: `${provider} ${profileName}`, mode: "fill", headroomPct: 0, notes: "" },
    ],
  });
}

describe("provider-divergence guard scoping (#335 / R6)", () => {
  const { db: database } = createTestDb();

  async function seedProject(name: string, archived = false): Promise<string> {
    const id = randomUUID();
    await database.insert(schema.projects).values({
      id,
      name,
      repoPath: `/tmp/${name}`,
      repoName: name,
      defaultBranch: "main",
      archivedAt: archived ? now : null,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async function setPrefs(entries: Array<{ key: string; value: string }>): Promise<void> {
    for (const e of entries) {
      await database.insert(schema.preferences).values({ ...e, updatedAt: now })
        .onConflictDoUpdate({ target: schema.preferences.key, set: { value: e.value, updatedAt: now } });
    }
  }

  beforeEach(async () => {
    await database.delete(schema.preferences);
    await database.delete(schema.projects);
  });

  it("rejects a diverging global write even when the ACTIVE project has no Bullseye", async () => {
    const withBullseye = await seedProject("has-bullseye");
    const activeNoBullseye = await seedProject("active-no-bullseye");
    await setPrefs([
      { key: "activeProjectId", value: activeNoBullseye },
      { key: `board_strategy_${withBullseye}`, value: bullseye("claude", "anth") },
      { key: "provider", value: "claude" },
      { key: "claude_profile", value: "anth" },
    ]);

    const result = await setPreferenceChecked(database, [{ key: "claude_profile", value: "other" }]);

    // Pre-#335 this was ACCEPTED: the guard only looked at the active project, which
    // has no Bullseye. The write's verdict no longer depends on the switcher.
    expect(result.divergence).not.toBeNull();
    expect(result.divergence?.projectId).toBe(withBullseye);
    const rows = await database.select().from(schema.preferences);
    expect(rows.find((r) => r.key === "claude_profile")?.value).toBe("anth");
  });

  it("stands down when two projects' Bullseyes demand different providers (no satisfiable global target)", async () => {
    const a = await seedProject("wants-claude");
    const b = await seedProject("wants-codex");
    await setPrefs([
      { key: "activeProjectId", value: a },
      { key: `board_strategy_${a}`, value: bullseye("claude", "anth") },
      { key: `board_strategy_${b}`, value: bullseye("codex", "work") },
      { key: "provider", value: "claude" },
      { key: "claude_profile", value: "anth" },
    ]);

    const result = await setPreferenceChecked(database, [{ key: "provider", value: "codex" }]);

    // No global provider value can agree with both Bullseyes, so rejecting would
    // block EVERY provider write on an arbitrary basis instead of enforcing coherence.
    expect(result.divergence).toBeNull();
    const rows = await database.select().from(schema.preferences);
    expect(rows.find((r) => r.key === "provider")?.value).toBe("codex");
  });

  it("gates against the project NAMED in the same write, not the active one", async () => {
    const active = await seedProject("active-claude");
    const named = await seedProject("named-codex");
    await setPrefs([
      { key: "activeProjectId", value: active },
      { key: `board_strategy_${active}`, value: bullseye("claude", "anth") },
      { key: "provider", value: "claude" },
      { key: "claude_profile", value: "anth" },
    ]);

    // Sets the named project's Bullseye to codex and the global provider to codex in
    // ONE call: self-consistent with respect to the project the write names, even
    // though it diverges from the (unmentioned) active project's Bullseye.
    const result = await setPreferenceChecked(database, [
      { key: `board_strategy_${named}`, value: bullseye("codex", "work") },
      { key: "provider", value: "codex" },
      { key: "codex_profile", value: "work" },
    ]);

    expect(result.divergence).toBeNull();
    const rows = await database.select().from(schema.preferences);
    expect(rows.find((r) => r.key === "provider")?.value).toBe("codex");
  });

  it("ignores a Bullseye belonging to an archived project", async () => {
    const archived = await seedProject("archived-claude", true);
    const live = await seedProject("live-no-bullseye");
    await setPrefs([
      { key: "activeProjectId", value: live },
      { key: `board_strategy_${archived}`, value: bullseye("claude", "anth") },
      { key: "provider", value: "claude" },
      { key: "claude_profile", value: "anth" },
    ]);

    const result = await setPreferenceChecked(database, [{ key: "provider", value: "codex" }]);

    expect(result.divergence).toBeNull();
    const rows = await database.select().from(schema.preferences);
    expect(rows.find((r) => r.key === "provider")?.value).toBe("codex");
  });
});
