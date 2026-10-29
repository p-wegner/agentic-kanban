import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describeRiskTagApplied, refuseSofterRiskTags, riskPosturePrefKeyFor, riskTagLevel } from "@agentic-kanban/shared/lib/risk-tag-guard";
import type { ToolDeps } from "./tools/deps.js";
import { mcpStructuredError } from "./db-utils.js";

/**
 * #1745 — MCP tools are agent-facing: a `risk:<level>` tag SOFTER than the project posture is
 * refused (stricter is fine). Returns the error result to hand back, or null when allowed.
 */
export async function guardRiskTags(
  db: ToolDeps["db"],
  schema: ToolDeps["schema"],
  projectId: string,
  tagNames: readonly string[],
) {
  if (!tagNames.some((n) => riskTagLevel(n))) return null;
  const rows = await db.select({ value: schema.preferences.value }).from(schema.preferences)
    .where(eq(schema.preferences.key, riskPosturePrefKeyFor(projectId))).limit(1);
  const refusal = refuseSofterRiskTags(tagNames, rows[0]?.value);
  return refusal ? mcpStructuredError("RISK_TAG_SOFTER_THAN_PROJECT", refusal) : null;
}

/** Audit trail for an applied `risk:` tag: an issue comment naming the level and the source. */
export async function recordRiskTagApplied(
  db: ToolDeps["db"],
  schema: ToolDeps["schema"],
  issueId: string,
  tagNames: readonly string[],
  source: string,
  now: string,
): Promise<void> {
  for (const name of tagNames) {
    const level = riskTagLevel(name);
    if (!level) continue;
    await db.insert(schema.issueComments).values({
      id: randomUUID(),
      issueId,
      workspaceId: null,
      kind: "note",
      author: "agent",
      body: describeRiskTagApplied(level, source),
      payload: JSON.stringify({ riskTag: name, source }),
      createdAt: now,
      repeatCount: 1,
      lastRepeatedAt: null,
    }).catch(() => {});
  }
}
