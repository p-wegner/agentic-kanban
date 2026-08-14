import { issues } from "@agentic-kanban/shared/schema";
import { onboardingUnitKeyPrefix } from "@agentic-kanban/shared/lib/onboarding-plan";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { escapeLikeLiteral } from "./plugins.repository.js";

/**
 * Every `external_key` in this project that marks an issue as filed by an onboarding step
 * (`onboarding:<projectId>:<stepId>`). The plan builder pairs this with
 * `parseOnboardingUnitKey` to derive each `init-skill`/`ticket` step's `done` status, and
 * `applyOnboardingStep` checks it before filing so re-applying a step is a no-op (#463).
 */
export async function listOnboardingUnitExternalKeys(
  projectId: string,
  database: Database = db,
): Promise<Set<string>> {
  const pattern = `${escapeLikeLiteral(onboardingUnitKeyPrefix(projectId))}%`;
  const rows = await database
    .select({ externalKey: issues.externalKey })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), sql`${issues.externalKey} LIKE ${pattern} ESCAPE '\\'`));
  return new Set(rows.flatMap((row) => (row.externalKey ? [row.externalKey] : [])));
}
