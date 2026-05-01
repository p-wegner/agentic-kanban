import { db } from "./index.js";
import { projects, projectStatuses, tags } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const DEFAULT_STATUSES = [
  { name: "Todo", sortOrder: 0, isDefault: true },
  { name: "In Progress", sortOrder: 1, isDefault: false },
  { name: "In Review", sortOrder: 2, isDefault: false },
  { name: "Done", sortOrder: 3, isDefault: false },
  { name: "Cancelled", sortOrder: 4, isDefault: false },
];

async function seed() {
  const now = new Date().toISOString();

  // Check if default project already exists
  const existing = await db.select().from(projects).limit(1);
  if (existing.length > 0) {
    console.log("Database already seeded, skipping.");
    return;
  }

  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "Default Project",
    description: "Default kanban project",
    color: "#3B82F6",
    createdAt: now,
    updatedAt: now,
  });

  for (const status of DEFAULT_STATUSES) {
    await db.insert(projectStatuses).values({
      id: randomUUID(),
      projectId,
      name: status.name,
      sortOrder: status.sortOrder,
      isDefault: status.isDefault,
      createdAt: now,
    });
  }

  console.log(`Seeded project "${projectId}" with ${DEFAULT_STATUSES.length} statuses.`);

  // Seed default tags
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

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
