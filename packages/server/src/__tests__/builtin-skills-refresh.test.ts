import { describe, it, expect, beforeEach } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { ensureBuiltinSkills } from "../db/seed.js";
import { BUILTIN_SKILLS, builtinSkillContentHash } from "../builtin-skills.js";

/**
 * Ticket 7 (arch-review §2.1): the builtin skill prompts used to live in TWO
 * forked arrays (seed.ts DEFAULT_SKILLS + builtin-skills.ts BUILTIN_SKILLS) and
 * non-whitelisted skills silently stayed stale in existing DBs. These tests lock
 * in the single-source + content-hash-refresh design.
 */

async function getGlobalBuiltin(db: TestDb, name: string) {
  const rows = await db
    .select()
    .from(schema.agentSkills)
    .where(and(eq(schema.agentSkills.name, name), isNull(schema.agentSkills.projectId)))
    .limit(1);
  return rows[0] ?? null;
}

describe("builtin skills — single source + content-hash refresh", () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("has ONE canonical list with unique names covering both former arrays", () => {
    const names = BUILTIN_SKILLS.map((s) => s.name);
    // No duplicates in the canonical list.
    expect(new Set(names).size).toBe(names.length);
    // Skills that used to live ONLY in seed.ts's DEFAULT_SKILLS...
    expect(names).toContain("workflow-builder");
    // ...and ONLY in builtin-skills.ts's BUILTIN_SKILLS...
    expect(names).toContain("tdd-mode");
    expect(names).toContain("merge-reconciler");
    expect(names).toContain("kanban-workflow");
    // ...and the overlapping ones are present exactly once.
    for (const shared of ["code-review", "butler", "dependency-analyzer", "monitor-nudge"]) {
      expect(names.filter((n) => n === shared)).toHaveLength(1);
    }
  });

  it("seeds exactly the canonical set as global built-ins, each stamped with its content hash", async () => {
    await ensureBuiltinSkills(db as never);
    const rows = await db
      .select()
      .from(schema.agentSkills)
      .where(and(isNull(schema.agentSkills.projectId), eq(schema.agentSkills.isBuiltin, true)));
    const seededNames = new Set(rows.map((r) => r.name));
    const canonicalNames = new Set(BUILTIN_SKILLS.map((s) => s.name));
    expect(seededNames).toEqual(canonicalNames);
    for (const row of rows) {
      const canonical = BUILTIN_SKILLS.find((s) => s.name === row.name)!;
      expect(row.contentHash).toBe(builtinSkillContentHash(canonical));
    }
  });

  it("refreshes an UNEDITED stale built-in when canonical content changed — code-review specifically", async () => {
    await ensureBuiltinSkills(db as never);

    const canonical = BUILTIN_SKILLS.find((s) => s.name === "code-review")!;
    const oldPrompt = "OUTDATED code-review prompt from an earlier release.";
    // Simulate a row seeded at a PRIOR canonical version and never user-edited:
    // its stored hash is internally consistent with its (old) content.
    const oldHash = builtinSkillContentHash({
      name: "code-review",
      description: canonical.description,
      prompt: oldPrompt,
      model: canonical.model,
    });
    await db
      .update(schema.agentSkills)
      .set({ prompt: oldPrompt, contentHash: oldHash })
      .where(and(eq(schema.agentSkills.name, "code-review"), isNull(schema.agentSkills.projectId)));

    await ensureBuiltinSkills(db as never);

    const row = await getGlobalBuiltin(db, "code-review");
    expect(row!.prompt).toBe(canonical.prompt);
    expect(row!.prompt).toMatch(/AI code reviewer/i);
    expect(row!.contentHash).toBe(builtinSkillContentHash(canonical));
  });

  it("refreshes a LEGACY built-in whose content_hash is NULL (pre-hash column)", async () => {
    await ensureBuiltinSkills(db as never);
    const canonical = BUILTIN_SKILLS.find((s) => s.name === "code-review")!;
    await db
      .update(schema.agentSkills)
      .set({ prompt: "legacy stale prompt", contentHash: null })
      .where(and(eq(schema.agentSkills.name, "code-review"), isNull(schema.agentSkills.projectId)));

    await ensureBuiltinSkills(db as never);

    const row = await getGlobalBuiltin(db, "code-review");
    expect(row!.prompt).toBe(canonical.prompt);
    expect(row!.contentHash).toBe(builtinSkillContentHash(canonical));
  });

  it("does NOT clobber a user-edited built-in row on refresh", async () => {
    await ensureBuiltinSkills(db as never);

    const canonical = BUILTIN_SKILLS.find((s) => s.name === "code-review")!;
    const userPrompt = "MY custom review prompt — please keep this.";
    // Stored hash reflects an OLDER baseline (so canonical differs from it), while the
    // content is the user's edit (so it also differs from the stored hash) → edited.
    const olderBaselineHash = builtinSkillContentHash({
      name: "code-review",
      description: canonical.description,
      prompt: "some earlier shipped prompt",
      model: canonical.model,
    });
    await db
      .update(schema.agentSkills)
      .set({ prompt: userPrompt, contentHash: olderBaselineHash })
      .where(and(eq(schema.agentSkills.name, "code-review"), isNull(schema.agentSkills.projectId)));

    await ensureBuiltinSkills(db as never);

    const row = await getGlobalBuiltin(db, "code-review");
    expect(row!.prompt).toBe(userPrompt);
  });

  it("is idempotent — a second seed adds/refreshes nothing", async () => {
    await ensureBuiltinSkills(db as never);
    const before = await db
      .select()
      .from(schema.agentSkills)
      .where(and(isNull(schema.agentSkills.projectId), eq(schema.agentSkills.isBuiltin, true)));
    await ensureBuiltinSkills(db as never);
    const after = await db
      .select()
      .from(schema.agentSkills)
      .where(and(isNull(schema.agentSkills.projectId), eq(schema.agentSkills.isBuiltin, true)));
    expect(after.length).toBe(before.length);
    // updatedAt of every row is unchanged (nothing was rewritten).
    const beforeByName = new Map(before.map((r) => [r.name, r.updatedAt]));
    for (const row of after) {
      expect(row.updatedAt).toBe(beforeByName.get(row.name));
    }
  });
});
