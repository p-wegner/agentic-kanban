import { randomUUID } from "node:crypto";
import { issues, projectStatuses, issueDependencies, agentSkills, tags, issueTags, projects } from "@agentic-kanban/shared/schema";
import { eq, and, inArray, sql, desc } from "drizzle-orm";
import type { DependencyType } from "@agentic-kanban/shared/schema";
import type { IssueEstimate } from "@agentic-kanban/shared";
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

export interface TouchedFile {
  path: string;
  reason: string;
  confidence: "high" | "medium" | "low";
}

export interface AnalyzeTouchedFilesResult {
  files: TouchedFile[];
  cached: boolean;
}

function buildDirTree(rootPath: string, maxDepth = 3): string {
  const lines: string[] = [];
  function walk(dir: string, depth: number, prefix: string) {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).filter(e => !e.startsWith(".") && e !== "node_modules" && e !== "dist" && e !== "build");
    } catch {
      return;
    }
    entries.sort();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const fullPath = join(dir, entry);
      const isLast = i === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      let stat;
      try { stat = statSync(fullPath); } catch { continue; }
      if (stat.isDirectory()) {
        lines.push(`${prefix}${connector}${entry}/`);
        walk(fullPath, depth + 1, prefix + (isLast ? "    " : "│   "));
      } else {
        lines.push(`${prefix}${connector}${entry}`);
      }
    }
  }
  walk(rootPath, 0, "");
  return lines.join("\n");
}

export async function analyzeTouchedFiles(
  issueId: string,
  database: Database,
  forceRefresh = false,
): Promise<AnalyzeTouchedFilesResult> {
  const issueRows = await database
    .select({
      id: issues.id,
      title: issues.title,
      description: issues.description,
      projectId: issues.projectId,
      touchedFilesJson: issues.touchedFilesJson,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (issueRows.length === 0) throw new NotFoundError("Issue not found");
  const issue = issueRows[0];

  if (!forceRefresh && issue.touchedFilesJson) {
    try {
      const cached = JSON.parse(issue.touchedFilesJson) as TouchedFile[];
      return { files: cached, cached: true };
    } catch {}
  }

  const projectRows = await database
    .select({ repoPath: projects.repoPath })
    .from(projects)
    .where(eq(projects.id, issue.projectId))
    .limit(1);
  const repoPath = projectRows[0]?.repoPath ?? "";

  let treeSection = "";
  if (repoPath) {
    try {
      const tree = buildDirTree(repoPath, 3);
      treeSection = tree ? `\nRepository directory structure:\n${tree}\n` : "";
    } catch {}
  }

  const prompt = `You are a software engineer. Given a kanban issue title and description, predict which source files the implementation will likely modify.
Focus on ${repoPath ? "the repository structure provided" : "the technologies mentioned in the issue"}.
Cap your answer at 12 files. Only include files that will be directly modified (not just read).
Respond ONLY with valid JSON — no markdown, no explanation:
{"files": [{"path": "relative/path/to/file.ts", "reason": "one sentence", "confidence": "high|medium|low"}]}
${treeSection}
Issue title: ${issue.title}
${issue.description ? `Description:\n${issue.description}` : ""}`;

  const stdout = await invokeClaudePrompt(prompt, { database, model: "claude-haiku-4-5" });
  const cleaned = stdout.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const parsed = JSON.parse(cleaned) as { files?: TouchedFile[] };
  const files: TouchedFile[] = (parsed.files ?? []).slice(0, 12).filter(
    f => f.path && f.reason && ["high", "medium", "low"].includes(f.confidence),
  );

  await database
    .update(issues)
    .set({ touchedFilesJson: JSON.stringify(files) })
    .where(eq(issues.id, issueId));

  return { files, cached: false };
}

export interface CheckOverlapResult {
  overlap: Record<string, string[]>;
}

export async function checkIssueOverlap(
  issueIds: string[],
  database: Database,
): Promise<CheckOverlapResult> {
  if (issueIds.length === 0) return { overlap: {} };

  const rows = await database
    .select({ id: issues.id, touchedFilesJson: issues.touchedFilesJson })
    .from(issues)
    .where(inArray(issues.id, issueIds));

  const overlap: Record<string, string[]> = {};
  for (const row of rows) {
    if (!row.touchedFilesJson) continue;
    let files: TouchedFile[];
    try { files = JSON.parse(row.touchedFilesJson); } catch { continue; }
    for (const f of files) {
      if (!overlap[f.path]) overlap[f.path] = [];
      if (!overlap[f.path].includes(row.id)) overlap[f.path].push(row.id);
    }
  }
  // Keep only files touched by >1 issue
  for (const path of Object.keys(overlap)) {
    if (overlap[path].length < 2) delete overlap[path];
  }
  return { overlap };
}

export interface AiEstimateResult {  estimate: IssueEstimate;
  reasoning: string;
}

const VALID_ESTIMATES: IssueEstimate[] = ["XS", "S", "M", "L", "XL"];

export async function aiEstimateIssue(
  issueId: string,
  database: Database,
): Promise<AiEstimateResult> {
  const issueRows = await database
    .select({ title: issues.title, description: issues.description })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (issueRows.length === 0) {
    throw new NotFoundError("Issue not found");
  }
  const { title, description } = issueRows[0];

  const prompt = `You are a software project estimator. Given a kanban issue, suggest a T-shirt size estimate.
Sizes: XS (< 1 hour), S (half day), M (1-2 days), L (3-5 days), XL (> 1 week).
Respond ONLY with valid JSON — no markdown, no explanation:
{"estimate": "XS|S|M|L|XL", "reasoning": "one sentence"}

Issue title: ${title}
${description ? `Description:\n${description}` : ""}`;

  const stdout = await invokeClaudePrompt(prompt, { database, model: "claude-haiku-4-5" });
  const cleaned = stdout.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const parsed = JSON.parse(cleaned) as { estimate?: string; reasoning?: string };

  const estimate = parsed.estimate?.trim().toUpperCase() as IssueEstimate;
  if (!VALID_ESTIMATES.includes(estimate)) {
    throw new Error(`AI returned invalid estimate: ${parsed.estimate}`);
  }
  return { estimate, reasoning: parsed.reasoning?.trim() ?? "" };
}

export interface DecomposeChildProposal {
  tempId: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "urgent";
}

export interface DecomposeDependencyProposal {
  fromTempId: string;
  toTempId: string;
  type: DependencyType;
}

export interface DecomposeEpicResult {
  children: DecomposeChildProposal[];
  dependencies: DecomposeDependencyProposal[];
  alreadyDecomposed: boolean;
}

export async function decomposeEpic(
  issueId: string,
  projectId: string,
  database: Database,
): Promise<DecomposeEpicResult> {
  const issueRows = await database
    .select({ id: issues.id, issueNumber: issues.issueNumber, title: issues.title, description: issues.description })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (issueRows.length === 0) throw new NotFoundError("Issue not found");
  const targetIssue = issueRows[0];

  // Check if already decomposed (has parent_of dependencies)
  const existingChildDeps = await database
    .select({ id: issueDependencies.id })
    .from(issueDependencies)
    .where(and(eq(issueDependencies.issueId, issueId), eq(issueDependencies.type, "parent_of")))
    .limit(1);
  const alreadyDecomposed = existingChildDeps.length > 0;

  // Get recent closed issues for context
  const doneStatuses = await database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(and(eq(projectStatuses.projectId, projectId), inArray(projectStatuses.name, ["Done", "Cancelled"])));
  const doneStatusIds = doneStatuses.map(s => s.id);

  let recentIssues: { title: string; description: string | null }[] = [];
  if (doneStatusIds.length > 0) {
    recentIssues = await database
      .select({ title: issues.title, description: issues.description })
      .from(issues)
      .where(and(
        eq(issues.projectId, projectId),
        inArray(issues.statusId, doneStatusIds),
      ))
      .orderBy(desc(issues.updatedAt))
      .limit(10);
  }

  const projectRows = await database
    .select({ name: projects.name, repoName: projects.repoName })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const projectName = projectRows[0]?.repoName || projectRows[0]?.name || "unknown project";

  const recentContext = recentIssues.length > 0
    ? `\nRecently completed tasks (for context on coding patterns):\n${recentIssues.map(i => `  - ${i.title}`).join("\n")}`
    : "";

  const prompt = `You are a software project planner. You must decompose a large epic ticket into smaller, focused child tickets that can each be completed in a single agent session (typically 1-4 hours of work each).

Project: ${projectName}
Epic title: ${targetIssue.title}
Epic description:
${targetIssue.description || "(no description)"}
${recentContext}

Rules:
- Generate 3-8 child tickets that together implement the full epic
- Each child ticket must be independently workable (no ambiguity)
- Titles should be actionable and specific (verb phrase, under 80 chars)
- Descriptions should be 2-4 sentences with clear acceptance criteria
- Use tempIds like "c1", "c2", etc.
- Dependency type must be "depends_on" (child depends on another child that must be done first)
- Only add dependencies when there is a genuine technical ordering requirement
- Priority: "low", "medium", "high", or "urgent"

Respond ONLY with valid JSON, no markdown, no explanation:
{
  "children": [
    {"tempId": "c1", "title": "...", "description": "...", "priority": "medium"},
    {"tempId": "c2", "title": "...", "description": "...", "priority": "medium"}
  ],
  "dependencies": [
    {"fromTempId": "c2", "toTempId": "c1", "type": "depends_on"}
  ]
}`;

  const stdout = await invokeClaudePrompt(prompt, { database });
  const cleaned = stdout.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const parsed = JSON.parse(cleaned) as {
    children?: Array<{ tempId: string; title: string; description: string; priority: string }>;
    dependencies?: Array<{ fromTempId: string; toTempId: string; type: string }>;
  };

  const validPriorities = ["low", "medium", "high", "urgent"];
  const validTypes: DependencyType[] = ["depends_on", "blocked_by", "related_to", "parent_of", "child_of"];
  const tempIds = new Set((parsed.children ?? []).map(c => c.tempId));

  const children: DecomposeChildProposal[] = (parsed.children ?? [])
    .filter(c => c.tempId && c.title?.trim())
    .map(c => ({
      tempId: c.tempId,
      title: c.title.trim(),
      description: c.description?.trim() ?? "",
      priority: (validPriorities.includes(c.priority) ? c.priority : "medium") as DecomposeChildProposal["priority"],
    }));

  const dependencies: DecomposeDependencyProposal[] = (parsed.dependencies ?? [])
    .filter(d => d.fromTempId && d.toTempId && tempIds.has(d.fromTempId) && tempIds.has(d.toTempId))
    .filter(d => validTypes.includes(d.type as DependencyType))
    .map(d => ({
      fromTempId: d.fromTempId,
      toTempId: d.toTempId,
      type: d.type as DependencyType,
    }));

  return { children, dependencies, alreadyDecomposed };
}

export interface ConfirmDecomposeInput {
  issueId: string;
  projectId: string;
  children: DecomposeChildProposal[];
  dependencies: DecomposeDependencyProposal[];
}

export interface ConfirmDecomposeResult {
  createdIssues: Array<{ id: string; issueNumber: number; title: string; tempId: string }>;
}

export async function confirmEpicDecomposition(
  input: ConfirmDecomposeInput,
  database: Database,
): Promise<ConfirmDecomposeResult> {
  const { issueId, projectId, children, dependencies } = input;

  // Ensure the parent issue exists
  const issueRows = await database
    .select({ id: issues.id, title: issues.title, description: issues.description })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (issueRows.length === 0) throw new NotFoundError("Issue not found");
  const parentIssue = issueRows[0];

  // Get Backlog status id
  const backlogStatus = await database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.name, "Backlog")))
    .limit(1);
  const backlogStatusId = backlogStatus[0]?.id;

  // Get or create epic tag
  let epicTag = await database
    .select({ id: tags.id })
    .from(tags)
    .where(eq(tags.name, "epic"))
    .limit(1);
  if (epicTag.length === 0) {
    const tagId = randomUUID();
    await database.insert(tags).values({
      id: tagId,
      name: "epic",
      color: "#8B5CF6",
      isBuiltin: true,
      createdAt: new Date().toISOString(),
    }).catch(() => {});
    epicTag = [{ id: tagId }];
  }

  // Create child issues
  const now = new Date().toISOString();
  const maxRow = await database
    .select({ maxNum: sql<number | null>`max(${issues.issueNumber})` })
    .from(issues)
    .where(eq(issues.projectId, projectId));
  let nextNumber = (maxRow[0]?.maxNum ?? 0) + 1;

  const defaultStatusRow = await database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId))
    .orderBy(projectStatuses.sortOrder)
    .limit(1);
  const defaultStatusId = backlogStatusId ?? defaultStatusRow[0]?.id;
  if (!defaultStatusId) throw new NotFoundError("No statuses found for project");

  const createdIssues: ConfirmDecomposeResult["createdIssues"] = [];
  const tempIdToIssueId = new Map<string, string>();

  for (const child of children) {
    const childId = randomUUID();
    const issueNumber = nextNumber++;
    await database.insert(issues).values({
      id: childId,
      issueNumber,
      title: child.title,
      description: child.description || null,
      priority: child.priority ?? "medium",
      issueType: "task",
      skipAutoReview: false,
      estimate: null,
      sortOrder: 0,
      statusId: defaultStatusId,
      projectId,
      createdAt: now,
      updatedAt: now,
    });
    createdIssues.push({ id: childId, issueNumber, title: child.title, tempId: child.tempId });
    tempIdToIssueId.set(child.tempId, childId);
  }

  // Wire dependency edges between children (fromTempId depends_on toTempId)
  for (const dep of dependencies) {
    const fromId = tempIdToIssueId.get(dep.fromTempId);
    const toId = tempIdToIssueId.get(dep.toTempId);
    if (!fromId || !toId) continue;
    try {
      await database.insert(issueDependencies).values({
        id: randomUUID(),
        issueId: fromId,
        dependsOnId: toId,
        type: dep.type,
        createdAt: now,
      });
    } catch { /* skip duplicate/cycle */ }
  }

  // Wire parent_of deps from parent to each child
  for (const child of createdIssues) {
    try {
      await database.insert(issueDependencies).values({
        id: randomUUID(),
        issueId: issueId,
        dependsOnId: child.id,
        type: "parent_of",
        createdAt: now,
      });
    } catch { /* skip */ }
  }

  // Add epic tag to parent issue (if not already tagged)
  const existingEpicTag = await database
    .select({ id: issueTags.id })
    .from(issueTags)
    .where(and(eq(issueTags.issueId, issueId), eq(issueTags.tagId, epicTag[0].id)))
    .limit(1);
  if (existingEpicTag.length === 0) {
    await database.insert(issueTags).values({
      id: randomUUID(),
      issueId,
      tagId: epicTag[0].id,
    }).catch(() => {});
  }

  // Prepend checklist of children to parent description
  const checklist = createdIssues.map(c => `- [ ] #${c.issueNumber} ${c.title}`).join("\n");
  const childrenSection = `## Subtasks (${createdIssues.length})\n${checklist}`;
  const newDescription = parentIssue.description
    ? `${childrenSection}\n\n${parentIssue.description}`
    : childrenSection;
  await database.update(issues)
    .set({ description: newDescription, updatedAt: now })
    .where(eq(issues.id, issueId));

  return { createdIssues };
}
