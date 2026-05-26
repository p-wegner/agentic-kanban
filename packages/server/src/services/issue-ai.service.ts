import { randomUUID } from "node:crypto";
import { issues, projectStatuses, issueDependencies, agentSkills } from "@agentic-kanban/shared/schema";
import { eq, and, inArray, sql } from "drizzle-orm";
import type { DependencyType } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import { invokeClaudePrompt } from "./claude-cli.service.js";
import { NotFoundError } from "../errors/index.js";

export interface EnhanceIssueResult {
  title: string;
  description: string;
}

export async function enhanceIssue(
  title: string,
  description: string | undefined,
  database: Database,
): Promise<EnhanceIssueResult> {
  const prompt = `You are helping enhance a kanban issue ticket for an AI coding agent.
Given a title and optional description, return an improved version that is clear, actionable, and well-structured.
Keep the title concise (under 80 chars). Expand the description with context, acceptance criteria, and agent instructions if helpful.
Also identify any open questions — unresolved decisions, assumptions, or clarifications needed before work begins.
Respond ONLY with valid JSON — no markdown, no explanation:
{"title": "...", "description": "...", "openQuestions": ["question 1", "question 2"]}

The openQuestions array should contain 1-5 concise questions as plain strings. Use an empty array if there are genuinely no ambiguities.

Current title: ${title}
Current description: ${description?.trim() || "(none)"}`;

  const stdout = await invokeClaudePrompt(prompt, { database });
  const output = stdout.trim();
  const cleaned = output.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const enhanced = JSON.parse(cleaned) as { title?: string; description?: string; openQuestions?: string[] };

  let enhancedDescription = enhanced.description?.trim() ?? description ?? "";
  const questions = Array.isArray(enhanced.openQuestions) ? enhanced.openQuestions.filter(q => typeof q === "string" && q.trim()) : [];
  if (questions.length > 0) {
    const questionsSection = "\n\n## Open Questions\n" + questions.map(q => `- [ ] ${q.trim()}`).join("\n");
    enhancedDescription = enhancedDescription + questionsSection;
  }

  return {
    title: enhanced.title?.trim() || title,
    description: enhancedDescription,
  };
}

export interface AnalyzeDependenciesResult {
  dependencies: Array<{ id: string; type: string; issueId: string; reason: string }>;
  total: number;
}

export async function analyzeDependencies(
  issueId: string,
  projectId: string,
  database: Database,
): Promise<AnalyzeDependenciesResult> {
  const issueRows = await database
    .select({ id: issues.id, issueNumber: issues.issueNumber, title: issues.title, description: issues.description })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (issueRows.length === 0) {
    throw new NotFoundError("Issue not found");
  }
  const targetIssue = issueRows[0];

  const doneCancelledStatuses = await database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(and(
      eq(projectStatuses.projectId, projectId),
      inArray(projectStatuses.name, ["Done", "Cancelled"]),
    ));
  const excludeStatusIds = doneCancelledStatuses.map(s => s.id);

  let openIssues: { id: string; issueNumber: number | null; title: string; description: string | null }[];
  if (excludeStatusIds.length > 0) {
    openIssues = await database
      .select({ id: issues.id, issueNumber: issues.issueNumber, title: issues.title, description: issues.description })
      .from(issues)
      .where(and(
        eq(issues.projectId, projectId),
        sql`${issues.statusId} NOT IN (${sql.join(excludeStatusIds.map(id => sql`${id}`), sql`, `)})`,
      ));
  } else {
    openIssues = await database
      .select({ id: issues.id, issueNumber: issues.issueNumber, title: issues.title, description: issues.description })
      .from(issues)
      .where(eq(issues.projectId, projectId));
  }

  const skillRows = await database
    .select({ prompt: agentSkills.prompt })
    .from(agentSkills)
    .where(and(
      eq(agentSkills.name, "dependency-analyzer"),
      sql`(${agentSkills.projectId} = ${projectId} OR ${agentSkills.projectId} IS NULL)`,
    ))
    .orderBy(sql`${agentSkills.projectId} IS NULL`)
    .limit(1);

  const skillPrompt = skillRows[0]?.prompt || `Analyze the given issue and its relationship to other open issues on the board.`;

  const issuesSummary = openIssues
    .filter(i => i.id !== issueId)
    .map(i => `  [${i.id}] #${i.issueNumber ?? "?"} ${i.title}${i.description ? `\n    ${i.description.split("\n")[0].slice(0, 100)}` : ""}`)
    .join("\n");

  const prompt = `${skillPrompt}

Target issue: [${targetIssue.id}] #${targetIssue.issueNumber ?? "?"} "${targetIssue.title}"
${targetIssue.description ? `Description: ${targetIssue.description}` : ""}

Other open issues on the board (each prefixed with its [id]):
${issuesSummary || "(no other open issues)"}

IMPORTANT: You must respond ONLY with valid JSON, no markdown, no explanation:
{"dependencies": [{"issueId": "<id from brackets>", "type": "depends_on|blocked_by|related_to|parent_of|child_of", "reason": "..."}]}

Use the exact id value from the [brackets] prefix for the issueId field.
Use "depends_on" when the target issue requires another issue to be done first.
Use "blocked_by" when another issue blocks this one.
Use "related_to" when issues share code or functionality.
Use "parent_of" when the target is an epic containing another issue.
Use "child_of" when the target is a subtask of another issue.
Only include genuinely useful dependencies, not just topical similarity.`;

  const stdout = await invokeClaudePrompt(prompt, { database });

  const output = stdout.trim();
  const cleaned = output.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const parsed = JSON.parse(cleaned) as { dependencies?: Array<{ issueId: string; type: string; reason: string }> };
  const deps = parsed.dependencies ?? [];

  const created: Array<{ id: string; type: string; issueId: string; reason: string }> = [];
  const validTypes: DependencyType[] = ["depends_on", "blocked_by", "related_to", "parent_of", "child_of"];

  for (const dep of deps) {
    if (!dep.issueId || !dep.type) continue;
    if (!validTypes.includes(dep.type as DependencyType)) continue;
    if (dep.issueId === issueId) continue;

    try {
      const id = randomUUID();
      await database.insert(issueDependencies).values({
        id,
        issueId,
        dependsOnId: dep.issueId,
        type: dep.type as DependencyType,
        createdAt: new Date().toISOString(),
      });
      created.push({ id, type: dep.type, issueId: dep.issueId, reason: dep.reason ?? "" });
    } catch (err: any) {
      if (err.message?.includes("UNIQUE constraint")) continue;
      console.error("[issue-ai] failed to create dependency:", err.message);
    }
  }

  return { dependencies: created, total: created.length };
}
