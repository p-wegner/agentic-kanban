import { describe, it, expect, beforeEach } from "vitest";
import { preferences } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { migrateGlobalDefaultModelToProviderScope } from "../startup/startup-tasks.js";

/**
 * #902 one-time migration: retire the global, provider-agnostic `default_model` pref.
 * It must move a live value into the active provider's scoped slot (when valid + empty)
 * and ALWAYS delete the global key, so a cross-provider model becomes unrepresentable.
 */
describe("#902 — migrateGlobalDefaultModelToProviderScope", () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  async function get(key: string): Promise<string | undefined> {
    const rows = await db.select({ value: preferences.value }).from(preferences).where(eq(preferences.key, key));
    return rows[0]?.value ?? undefined;
  }

  it("is a no-op when the global key is absent", async () => {
    await db.insert(preferences).values({ key: "provider", value: "claude" });
    await migrateGlobalDefaultModelToProviderScope(db);
    expect(await get("default_model")).toBeUndefined();
    expect(await get("default_model_claude")).toBeUndefined();
  });

  it("moves a provider-matching global value into the active provider's empty slot, then deletes the global key", async () => {
    await db.insert(preferences).values([
      { key: "provider", value: "claude" },
      { key: "default_model", value: "opus" },
    ]);
    await migrateGlobalDefaultModelToProviderScope(db);
    expect(await get("default_model")).toBeUndefined();
    expect(await get("default_model_claude")).toBe("opus");
  });

  it("does NOT overwrite an existing provider-scoped slot, but still deletes the global key", async () => {
    await db.insert(preferences).values([
      { key: "provider", value: "codex" },
      { key: "default_model", value: "gpt-5.4" },
      { key: "default_model_codex", value: "gpt-5.5" },
    ]);
    await migrateGlobalDefaultModelToProviderScope(db);
    expect(await get("default_model")).toBeUndefined();
    expect(await get("default_model_codex")).toBe("gpt-5.5");
  });

  it("DROPS a wrong-provider global value (the #696 footgun) — never copies it across providers", async () => {
    // Active provider is claude but the leftover global value is a Codex id. It must NOT
    // land in default_model_claude, and the global key must be deleted.
    await db.insert(preferences).values([
      { key: "provider", value: "claude" },
      { key: "default_model", value: "gpt-5.5" },
    ]);
    await migrateGlobalDefaultModelToProviderScope(db);
    expect(await get("default_model")).toBeUndefined();
    expect(await get("default_model_claude")).toBeUndefined();
  });

  it("deletes an empty/whitespace global key without touching scoped slots", async () => {
    await db.insert(preferences).values([
      { key: "provider", value: "claude" },
      { key: "default_model", value: "   " },
      { key: "default_model_claude", value: "sonnet" },
    ]);
    await migrateGlobalDefaultModelToProviderScope(db);
    expect(await get("default_model")).toBeUndefined();
    expect(await get("default_model_claude")).toBe("sonnet");
  });

  it("is idempotent — a second run is a clean no-op", async () => {
    await db.insert(preferences).values([
      { key: "provider", value: "claude" },
      { key: "default_model", value: "opus" },
    ]);
    await migrateGlobalDefaultModelToProviderScope(db);
    await migrateGlobalDefaultModelToProviderScope(db);
    expect(await get("default_model")).toBeUndefined();
    expect(await get("default_model_claude")).toBe("opus");
  });
});
