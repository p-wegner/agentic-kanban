import { db } from "./index.js";
import type { Database } from "./index.js";
import { tags, agentSkills } from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { BUILTIN_SKILLS, builtinSkillContentHash } from "../builtin-skills.js";

/** Built-in tags that must always exist and cannot be deleted or renamed. */
export const BUILTIN_TAGS = [
  { name: "needs-visual-verification", color: "#F59E0B" },
  { name: "epic", color: "#8B5CF6" },
  { name: "no-auto-start", color: "#6B7280" },
] as const;

export async function ensureBuiltinTags(database: Database = db): Promise<void> {
  const now = new Date().toISOString();
  // Read all existing tags by name to handle both missing and non-builtin cases
  const existing = await database.select({ name: tags.name, isBuiltin: tags.isBuiltin }).from(tags);
  const existingByName = new Map(existing.map(r => [r.name, r.isBuiltin]));

  let added = 0;
  for (const tag of BUILTIN_TAGS) {
    if (existingByName.has(tag.name)) {
      // Tag exists — ensure it's marked as builtin (handles pre-migration DBs)
      if (!existingByName.get(tag.name)) {
        await database.update(tags).set({ isBuiltin: true }).where(eq(tags.name, tag.name)).catch(() => {});
        console.log(`[seed] marked tag "${tag.name}" as built-in`);
      }
      continue;
    }
    await database.insert(tags).values({
      id: randomUUID(),
      name: tag.name,
      color: tag.color,
      isBuiltin: true,
      createdAt: now,
    }).catch(() => {/* race-safe: ignore if concurrently inserted */});
    added++;
  }
  if (added > 0) {
    console.log(`Seeded ${added} built-in tag(s).`);
  }
}

export async function seed() {
  const now = new Date().toISOString();

  // Upsert required built-in tags — always run, regardless of whether other tags exist
  await ensureBuiltinTags();

  // Seed default non-builtin tags only if the DB has no non-builtin tags yet
  const existingTags = await db.select({ id: tags.id }).from(tags);
  if (existingTags.length > BUILTIN_TAGS.length) {
    console.log("Tags already seeded, skipping default tags.");
  } else {
    const DEFAULT_TAGS = [
      { name: "bug", color: "#EF4444" },
      { name: "feature", color: "#3B82F6" },
      { name: "improvement", color: "#8B5CF6" },
      { name: "docs", color: "#10B981" },
    ];
    for (const tag of DEFAULT_TAGS) {
      await db.insert(tags).values({
        id: randomUUID(),
        name: tag.name,
        color: tag.color,
        createdAt: now,
      });
    }
    console.log(`Seeded ${DEFAULT_TAGS.length} default tags.`);
  }

  await ensureBuiltinSkills();

  const { ensureBuiltinWorkflows } = await import("./builtin-workflows.js");
  await ensureBuiltinWorkflows();

  console.log('Run `agentic-kanban init <path>` to register a git repo as a project.');
}

/**
 * Upsert all built-in agent skills from the single canonical source
 * (`BUILTIN_SKILLS` in `builtin-skills.ts`). Idempotent; called from seed() and on
 * server startup so a reconstructed DB always has its built-in skills (and Workspace
 * Quick Actions).
 *
 * Refresh policy (replaces the old hand-picked force-refresh whitelist): for each
 * GLOBAL built-in row (project-scoped overrides are NEVER touched), we compare the
 * row's stored `contentHash` against the canonical content hash. A missing row is
 * inserted; an up-to-date row is skipped; a stale row is refreshed **only if it has
 * not been user-edited**. "Unedited" = the stored hash still matches the row's
 * current content (nobody changed it since we last wrote it), OR the row predates the
 * `content_hash` column (legacy global built-in — adopt the shipped content). Because
 * user edits change the content without updating `contentHash`, a hand-modified row is
 * detected (its content hash no longer matches the stored one) and preserved. This
 * keeps ALL unedited built-ins — including `code-review`, which drives every
 * auto-review — current after a prompt edit, instead of silently staying stale.
 */
export async function ensureBuiltinSkills(database: Database = db): Promise<void> {
  const now = new Date().toISOString();

  const existingRows = await database
    .select({
      name: agentSkills.name,
      description: agentSkills.description,
      prompt: agentSkills.prompt,
      model: agentSkills.model,
      contentHash: agentSkills.contentHash,
    })
    .from(agentSkills)
    .where(and(isNull(agentSkills.projectId), eq(agentSkills.isBuiltin, true)));
  const byName = new Map(existingRows.map((r) => [r.name, r]));

  let added = 0;
  let refreshed = 0;
  for (const skill of BUILTIN_SKILLS) {
    const canonicalHash = builtinSkillContentHash(skill);
    const row = byName.get(skill.name);

    if (!row) {
      await database.insert(agentSkills).values({
        id: randomUUID(),
        name: skill.name,
        description: skill.description,
        prompt: skill.prompt,
        model: skill.model,
        isBuiltin: true,
        contentHash: canonicalHash,
        createdAt: now,
        updatedAt: now,
      });
      added++;
      continue;
    }

    if (row.contentHash === canonicalHash) continue; // already up to date

    // Refresh only unedited rows (see the refresh-policy doc comment above). A legacy
    // row with a NULL hash predates the column — adopt the shipped content.
    const currentContentHash = builtinSkillContentHash(row);
    const unedited = row.contentHash === null || row.contentHash === currentContentHash;
    if (!unedited) continue; // user-customized — preserve

    await database
      .update(agentSkills)
      .set({
        description: skill.description,
        prompt: skill.prompt,
        model: skill.model,
        contentHash: canonicalHash,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentSkills.name, skill.name),
          isNull(agentSkills.projectId),
          eq(agentSkills.isBuiltin, true),
        ),
      );
    refreshed++;
  }

  if (added > 0 || refreshed > 0) {
    console.log(`Built-in skills: ${added} added, ${refreshed} refreshed.`);
  } else {
    console.log("Agent skills already up to date.");
  }
}

// Auto-run only when invoked directly (tsx src/db/seed.ts or node dist/seed.js)
const scriptPath = process.argv[1];
if (scriptPath && (scriptPath.endsWith("seed.ts") || scriptPath.endsWith("seed.js") || scriptPath.includes("db/seed"))) {
  seed().catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
}
