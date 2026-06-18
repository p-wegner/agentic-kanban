import { eq } from "drizzle-orm";
import { agentSkills } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * Resolve the default onboarding skill (board-navigator) so a freshly-registered project's
 * worktrees aren't skill-less. Returns null gracefully if the builtin isn't seeded. (#531)
 */
export async function getBoardNavigatorSkillId(database: Database = db): Promise<string | null> {
  const [nav] = await database
    .select({ id: agentSkills.id })
    .from(agentSkills)
    .where(eq(agentSkills.name, "board-navigator"))
    .limit(1);
  return nav?.id ?? null;
}
