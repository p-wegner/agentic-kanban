import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { registerSetPreference } from "../../tools/set-preference.js";
import { setupTool, parseResult } from "../helpers/tool-harness.js";

const PROJECT_ID = "0b3f1a2c-4d5e-6789-abcd-ef0123456789";

async function readPref(db: any, key: string) {
  const rows = await db.select().from(schema.preferences).where(eq(schema.preferences.key, key));
  return rows.length ? rows[0].value : null;
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
