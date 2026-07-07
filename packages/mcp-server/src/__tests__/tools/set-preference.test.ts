import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { registerSetPreference } from "../../tools/set-preference.js";
import { setupTool, parseResult } from "../helpers/tool-harness.js";
import { seedProject, setActiveProject } from "../helpers/seed.js";

const PROJECT_ID = "0b3f1a2c-4d5e-6789-abcd-ef0123456789";

async function readPref(db: any, key: string) {
  const rows = await db.select().from(schema.preferences).where(eq(schema.preferences.key, key));
  return rows.length ? rows[0].value : null;
}

async function insertPrefs(db: any, entries: Array<{ key: string; value: string }>) {
  const now = new Date().toISOString();
  for (const { key, value } of entries) {
    await db.insert(schema.preferences).values({ key, value, updatedAt: now });
  }
}

describe("set_preference tool (#989 validation)", () => {
  it("rejects an unknown key loudly and writes nothing", async () => {
    const { invoke, db } = setupTool(registerSetPreference);

    const result = await invoke({ key: "definitely_not_a_setting", value: "x" });
    const data = parseResult(result);

    expect(result.isError).toBe(true);
    expect(data.ok).toBe(false);
    expect(data.error).toContain('"definitely_not_a_setting"');
    expect(data.error).toContain("dynamic-preference-keys");
    expect(await readPref(db, "definitely_not_a_setting")).toBeNull();
  });

  it("rejects a typo'd start_mode key (non-uuid suffix) instead of silently accepting it", async () => {
    const { invoke, db } = setupTool(registerSetPreference);

    const key = "start_mode_NotAUuid";
    const result = await invoke({ key, value: "manual" });
    const data = parseResult(result);

    expect(result.isError).toBe(true);
    expect(data.error).toContain(key);
    expect(await readPref(db, key)).toBeNull();
  });

  it("rejects a case-wrong start_mode value (no coercion) and writes nothing", async () => {
    const { invoke, db } = setupTool(registerSetPreference);

    const key = `start_mode_${PROJECT_ID}`;
    const result = await invoke({ key, value: "Manual" });
    const data = parseResult(result);

    expect(result.isError).toBe(true);
    expect(data.ok).toBe(false);
    expect(data.error).toContain("manual | monitor | conductor");
    expect(await readPref(db, key)).toBeNull();
  });

  it("rejects an unknown start_mode value entirely", async () => {
    const { invoke, db } = setupTool(registerSetPreference);

    const key = `start_mode_${PROJECT_ID}`;
    const result = await invoke({ key, value: "auto" });

    expect(result.isError).toBe(true);
    expect(await readPref(db, key)).toBeNull();
  });

  it("accepts a valid dynamic key with a valid enum value", async () => {
    const { invoke, db } = setupTool(registerSetPreference);

    const key = `start_mode_${PROJECT_ID}`;
    const data = parseResult(await invoke({ key, value: "manual" }));

    expect(data.ok).toBe(true);
    expect(await readPref(db, key)).toBe("manual");
  });

  it("accepts a valid static settings-registry key", async () => {
    const { invoke, db } = setupTool(registerSetPreference);

    const data = parseResult(await invoke({ key: "claude_profile", value: "anth" }));

    expect(data.ok).toBe(true);
    expect(await readPref(db, "claude_profile")).toBe("anth");
  });

  it("keeps board_strategy_<projectId> JSON passthrough working", async () => {
    const { invoke, db } = setupTool(registerSetPreference);

    const key = `board_strategy_${PROJECT_ID}`;
    const json = JSON.stringify({ segments: [{ id: "s1", label: "Features", weight: 1 }] });
    const data = parseResult(await invoke({ key, value: json }));

    expect(data.ok).toBe(true);
    expect(await readPref(db, key)).toBe(json);
  });

  it("accepts per-harness plan_auto_continue keys and upserts on conflict", async () => {
    const { invoke, db } = setupTool(registerSetPreference);

    const key = "harness.codex.plan_auto_continue";
    expect(parseResult(await invoke({ key, value: "false" })).ok).toBe(true);
    expect(parseResult(await invoke({ key, value: "true" })).ok).toBe(true);
    expect(await readPref(db, key)).toBe("true");
  });
});

// arch-review §3.3 — the MCP set_preference side door used to do a RAW upsert,
// skipping BOTH the provider-divergence guard and objective.md regeneration. It now
// routes through the shared checked-write, so both fire from the MCP path too.
describe("set_preference tool — provider-divergence guard (arch-review §3.3)", () => {
  const claudeFillBullseye = JSON.stringify({
    providerPolicies: [
      { id: "p1", provider: "claude", profileName: "anth", label: "Claude anth", mode: "fill", headroomPct: 0, notes: "" },
    ],
  });

  it("rejects `provider=codex` that would diverge from the active project's Bullseye; writes nothing", async () => {
    const { invoke, db } = setupTool(registerSetPreference);
    const { projectId } = await seedProject(db, "mcp-divergence");
    await setActiveProject(db, projectId);
    await insertPrefs(db, [
      { key: `board_strategy_${projectId}`, value: claudeFillBullseye },
      { key: "provider", value: "claude" },
      { key: "claude_profile", value: "anth" },
    ]);

    const result = await invoke({ key: "provider", value: "codex" });
    const data = parseResult(result);

    expect(result.isError).toBe(true);
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/Bullseye/i);
    expect(data.divergence).toBeTruthy();
    // Nothing persisted — the raw upsert used to write this and recreate the #903 drift.
    expect(await readPref(db, "provider")).toBe("claude");
  });

  it("rejects a diverging `claude_profile` write; writes nothing", async () => {
    const { invoke, db } = setupTool(registerSetPreference);
    const { projectId } = await seedProject(db, "mcp-divergence-profile");
    await setActiveProject(db, projectId);
    await insertPrefs(db, [
      { key: `board_strategy_${projectId}`, value: claudeFillBullseye },
      { key: "provider", value: "claude" },
      { key: "claude_profile", value: "anth" },
    ]);

    const result = await invoke({ key: "claude_profile", value: "work" });
    expect(result.isError).toBe(true);
    expect(await readPref(db, "claude_profile")).toBe("anth");
  });

  it("allows a provider/profile write that AGREES with the Bullseye", async () => {
    const { invoke, db } = setupTool(registerSetPreference);
    const { projectId } = await seedProject(db, "mcp-divergence-agree");
    await setActiveProject(db, projectId);
    await insertPrefs(db, [
      { key: `board_strategy_${projectId}`, value: claudeFillBullseye },
      { key: "provider", value: "claude" },
      { key: "claude_profile", value: "work" },
    ]);

    const data = parseResult(await invoke({ key: "claude_profile", value: "anth" }));
    expect(data.ok).toBe(true);
    expect(await readPref(db, "claude_profile")).toBe("anth");
  });
});

describe("set_preference tool — objective.md regeneration (arch-review §3.3)", () => {
  it("regenerates the repo's objective.md when a board_strategy Bullseye is written via MCP", async () => {
    const { invoke, db } = setupTool(registerSetPreference);
    const repo = mkdtempSync(join(tmpdir(), "mcp-objective-"));
    try {
      mkdirSync(join(repo, "scripts", "board-monitor"), { recursive: true });
      const objectivePath = join(repo, "scripts", "board-monitor", "objective.md");
      writeFileSync(objectivePath, [
        "# Objective",
        "",
        "## TUNABLE TARGETS - generated from Strategy Bullseye",
        "<!-- STRATEGY_BULLSEYE_GENERATED_START -->",
        "stale block",
        "<!-- STRATEGY_BULLSEYE_GENERATED_END -->",
      ].join("\n"), "utf8");

      const projectId = randomUUID();
      const now = new Date().toISOString();
      await db.insert(schema.projects).values({
        id: projectId, name: "mcp-objective", repoPath: repo, repoName: "mcp-objective",
        defaultBranch: "main", createdAt: now, updatedAt: now,
      });
      // Skip the objective.md git auto-commit — assert only that the file is regenerated.
      await insertPrefs(db, [{ key: "auto_commit_strategy_objective", value: "false" }]);

      const key = `board_strategy_${projectId}`;
      const config = JSON.stringify({
        segments: [{ id: "perf", label: "REST API Performance", kind: "area", weight: 5, keywords: "performance" }],
      });
      const data = parseResult(await invoke({ key, value: config }));

      expect(data.ok).toBe(true);
      expect(await readPref(db, key)).toBe(config);

      // The raw-upsert side door never touched this file; the checked write does.
      const rewritten = readFileSync(objectivePath, "utf8");
      expect(rewritten).toContain("REST API Performance");
      expect(rewritten).toContain("STRATEGY WEIGHTS");
      expect(rewritten).not.toContain("stale block");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
