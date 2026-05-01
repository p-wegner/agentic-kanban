import { db } from "./index.js";
import { tags } from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";

async function seed() {
  // Seed default tags (global, not project-scoped)
  const existing = await db.select().from(tags).limit(1);
  if (existing.length > 0) {
    console.log("Tags already seeded, skipping.");
    return;
  }

  const now = new Date().toISOString();
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
  console.log('Run `pnpm cli -- register <path>` to register a git repo as a project.');
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
