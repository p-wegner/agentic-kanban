import { db } from "./index.js";
import { projects, projectStatuses } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const DEFAULT_STATUSES = [
  { name: "Todo", sortOrder: 0 },
  { name: "In Progress", sortOrder: 1 },
  { name: "In Review", sortOrder: 2 },
  { name: "Done", sortOrder: 3 },
  { name: "Cancelled", sortOrder: 4 },
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
      createdAt: now,
    });
  }

  console.log(`Seeded project "${projectId}" with ${DEFAULT_STATUSES.length} statuses.`);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
