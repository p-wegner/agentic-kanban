// #975 — runtime state lives in `runtime_state`, NOT `preferences` (the closed,
// registry-backed config set). Guards the separation and the TTL sweep.
import { describe, it, expect } from "vitest";
import { preferences, runtimeState } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  cleanupExpiredRuntimeState,
  deleteRuntimeState,
  getRuntimeState,
  getRuntimeStateByPrefix,
  setRuntimeState,
} from "../repositories/runtime-state.repository.js";
import { isAnswered, markAnswered, markDismissed } from "../services/agent-questions/markers.js";
import { isRuntimeStateKey } from "../lib/runtime-state-keys.js";

describe("runtime-state repository", () => {
  it("roundtrips get/set/delete", async () => {
    const { db } = createTestDb();
    expect(await getRuntimeState("k", db)).toBeNull();
    await setRuntimeState("k", "v", db);
    expect(await getRuntimeState("k", db)).toBe("v");
    await setRuntimeState("k", "v2", db); // upsert
    expect(await getRuntimeState("k", db)).toBe("v2");
    await deleteRuntimeState("k", db);
    expect(await getRuntimeState("k", db)).toBeNull();
  });

  it("reads by prefix", async () => {
    const { db } = createTestDb();
    await setRuntimeState("agent_question_answered_a", "1", db);
    await setRuntimeState("agent_question_answered_b", "1", db);
    await setRuntimeState("butler_session_p", "sid", db);
    const rows = await getRuntimeStateByPrefix("agent_question_answered_", db);
    expect(rows.map((r) => r.key).sort()).toEqual([
      "agent_question_answered_a",
      "agent_question_answered_b",
    ]);
  });

  it("cleanupExpiredRuntimeState removes only rows whose expiresAt is before `now`", async () => {
    const { db } = createTestDb();
    // TTL'd rows: one already expired, one far in the future; one with no TTL.
    await setRuntimeState("expired", "x", db, { expiresAt: "2020-01-01T00:00:00.000Z" });
    await setRuntimeState("future", "x", db, { expiresAt: "2999-01-01T00:00:00.000Z" });
    await setRuntimeState("no_ttl", "x", db); // expiresAt null → never swept

    const removed = await cleanupExpiredRuntimeState("2026-01-01T00:00:00.000Z", db);
    expect(removed).toBe(1);
    expect(await getRuntimeState("expired", db)).toBeNull();
    expect(await getRuntimeState("future", db)).toBe("x");
    expect(await getRuntimeState("no_ttl", db)).toBe("x");
  });

  it("setRuntimeState with ttlMs stamps a future expiry", async () => {
    const { db } = createTestDb();
    await setRuntimeState("ttl", "x", db, { ttlMs: 60_000 });
    // Not expired against a `now` right about now.
    expect(await cleanupExpiredRuntimeState(new Date(Date.now() - 1000).toISOString(), db)).toBe(0);
    expect(await getRuntimeState("ttl", db)).toBe("x");
  });
});

describe("agent-question markers use runtime_state, not preferences (#975)", () => {
  it("markAnswered / markDismissed write to runtime_state and leave preferences empty", async () => {
    const { db } = createTestDb();

    await markAnswered("tu-answered", db);
    await markDismissed("tu-dismissed", "2026-05-28T11:45:00.000Z", db);

    expect(await isAnswered("tu-answered", db)).toBe(true);
    expect(await isAnswered("tu-dismissed", db)).toBe(true);

    const prefRows = await db.select().from(preferences);
    const stateRows = await db.select().from(runtimeState);

    // No answered-marker leaked into the config table.
    expect(prefRows.some((r) => r.key.startsWith("agent_question_answered_"))).toBe(false);
    // Both markers landed in runtime_state.
    expect(stateRows.map((r) => r.key).sort()).toEqual([
      "agent_question_answered_tu-answered",
      "agent_question_answered_tu-dismissed",
    ]);
  });
});

describe("isRuntimeStateKey classifies the migrated namespaces", () => {
  it("recognizes runtime-state keys and rejects config keys", () => {
    expect(isRuntimeStateKey("agent_question_answered_tu-1")).toBe(true);
    expect(isRuntimeStateKey("agent_question_recommendation_tu-1")).toBe(true);
    expect(isRuntimeStateKey("butler_session_proj")).toBe(true);
    expect(isRuntimeStateKey("butler_session_history_proj")).toBe(true);
    expect(isRuntimeStateKey("agent_profile_launch_failure.claude:default")).toBe(true);
    expect(isRuntimeStateKey("backlog_empty_last_run")).toBe(true);

    // Config keys (registry + declared dynamic) are NOT runtime state.
    expect(isRuntimeStateKey("auto_merge")).toBe(false);
    expect(isRuntimeStateKey("butler_profile_proj")).toBe(false);
    expect(isRuntimeStateKey("backlog_empty_cooldown_min")).toBe(false);
    expect(isRuntimeStateKey("board_strategy_proj")).toBe(false);
  });
});
