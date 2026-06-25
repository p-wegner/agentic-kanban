import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isTerminalStatusIdView, TERMINAL_STATUS_NAMES } from "@agentic-kanban/shared";
import type { DependencyType } from "@agentic-kanban/shared/schema";
import type { IssueEstimate } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import { invokeClaudePrompt } from "./claude-cli.service.js";
import { NotFoundError } from "../errors/index.js";
import { createDrive } from "../repositories/drive.repository.js";
import * as repo from "../repositories/issue-ai.repository.js";
import { nextIssueNumber } from "../repositories/issue-number.repository.js";

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
Do not add build-time screenshot, browser automation, Playwright, or browser-install instructions. If visual confirmation is relevant, mention only that it is board-owned after-merge verification configured via visual_verification_mode / after_merge_verify_agent, not a builder task.
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

/** A stored dependency edge as seen by the coupling guard. */
export interface SequentialGuardEdge {
  issueId: string;
  dependsOnId: string;
  type: string;
}

/**
 * Guard predicate for the analyzer (#916): a `coupled_with` peer edge must NOT be
 * auto-created between two issues that already have a sequential (`depends_on` /
 * `blocked_by`) edge in EITHER direction — those pairs are sequential by design, and
 * silently converting them to parallel coupling would be wrong. Returns true when such
 * a sequential edge exists (so the caller should flag instead of create).
 */
export function isCouplingAcrossSequentialEdge(
  issueId: string,
  otherId: string,
  edges: SequentialGuardEdge[],
): boolean {
  return edges.some(
    (e) =>
      (e.type === "depends_on" || e.type === "blocked_by") &&
      ((e.issueId === issueId && e.dependsOnId === otherId) ||
        (e.issueId === otherId && e.dependsOnId === issueId)),
  );
}

export interface AnalyzeDependenciesResult {
  dependencies: Array<{ id: string; type: string; issueId: string; reason: string }>;
  /** Suggestions intentionally NOT created — e.g. a `coupled_with` across an existing sequential edge. */
  flagged?: Array<{ issueId: string; type: string; reason: string }>;
  total: number;
}

export async function analyzeDependencies(
  issueId: string,
  projectId: string,
  database: Database,
): Promise<AnalyzeDependenciesResult> {
  const targetIssue = await repo.getIssueBasics(issueId, database);
  if (!targetIssue) {
    throw new NotFoundError("Issue not found");
  }

  const excludeStatusIds = await repo.getTerminalStatusIds(projectId, [...TERMINAL_STATUS_NAMES], database);

  const terminalStatusIds = new Set(excludeStatusIds);
  const openIssues = (await repo.getOpenIssuesWithNode(projectId, database))
    .filter((issue) => !isTerminalStatusIdView(issue, terminalStatusIds));

  const skillPrompt = (await repo.getSkillPrompt("dependency-analyzer", projectId, database)) || `Analyze the given issue and its relationship to other open issues on the board.`;

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
{"dependencies": [{"issueId": "<id from brackets>", "type": "depends_on|blocked_by|related_to|parent_of|child_of|coupled_with", "reason": "..."}]}

Use the exact id value from the [brackets] prefix for the issueId field.
Use "depends_on" when the target issue requires another issue to be done first.
Use "blocked_by" when another issue blocks this one.
Use "related_to" when issues share code or functionality.
Use "coupled_with" when two issues touch the same code and are best implemented together (peer coupling); distinct from depends_on (sequential) and related_to (topical only).
Use "parent_of" when the target is an epic containing another issue.
Use "child_of" when the target is a subtask of another issue.
Only include genuinely useful dependencies, not just topical similarity.`;

  const stdout = await invokeClaudePrompt(prompt, { database });

  const output = stdout.trim();
  const cleaned = output.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const parsed = JSON.parse(cleaned) as { dependencies?: Array<{ issueId: string; type: string; reason: string }> };
  const deps = parsed.dependencies ?? [];

  const created: Array<{ id: string; type: string; issueId: string; reason: string }> = [];
  const flagged: Array<{ issueId: string; type: string; reason: string }> = [];
  const validTypes: DependencyType[] = ["depends_on", "blocked_by", "related_to", "parent_of", "child_of", "coupled_with"];

  // Guard: `coupled_with` is peer/parallel coupling and must NOT be auto-created across an
  // existing `depends_on`/`blocked_by` edge — those pairs are sequential-by-design. Flag
  // such a suggestion instead of writing it (the analyzer should not silently convert a
  // sequential relationship into a parallel one). Existing edges are checked in BOTH
  // directions since `coupled_with` is symmetric.
  const existingEdges = await repo.getDependencyEdgesBetween(
    issueId,
    deps.map((d) => d.issueId).filter((id): id is string => Boolean(id) && id !== issueId),
    database,
  );

  for (const dep of deps) {
    if (!dep.issueId || !dep.type) continue;
    if (!validTypes.includes(dep.type as DependencyType)) continue;
    if (dep.issueId === issueId) continue;

    if (dep.type === "coupled_with" && isCouplingAcrossSequentialEdge(issueId, dep.issueId, existingEdges)) {
      flagged.push({ issueId: dep.issueId, type: dep.type, reason: dep.reason ?? "" });
      continue;
    }

    try {
      const id = randomUUID();
      await repo.insertIssueDependency({
        id,
        issueId,
        dependsOnId: dep.issueId,
        type: dep.type as DependencyType,
        createdAt: new Date().toISOString(),
      }, database);
      created.push({ id, type: dep.type, issueId: dep.issueId, reason: dep.reason ?? "" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : undefined;
      if (message?.includes("UNIQUE constraint")) continue;
      console.error("[issue-ai] failed to create dependency:", message);
    }
  }

  return { dependencies: created, flagged, total: created.length };
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

/**
 * Extract a JSON object from raw model output, tolerating prose and markdown
 * fences around it. The `claude` CLI with `--output-format text -p` (especially
 * the Haiku model) frequently prefixes/suffixes the JSON with conversational
 * text ("Perfect! Here's the answer:\n```json\n{...}\n```"), so stripping only
 * leading/trailing fences is not enough — we locate the first balanced `{...}`.
 */
export function extractJsonObject(text: string): unknown {
  if (!text) throw new Error("empty model response");
  let s = text.trim();
  // Strip a ```json ... ``` or ``` ... ``` fence if the JSON lives inside one.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  // Tolerate leading/trailing prose by slicing from the first `{` to the last `}`.
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("no JSON object found in model response");
  }
  return JSON.parse(s.slice(start, end + 1));
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
  const issue = await repo.getIssueForTouchedFiles(issueId, database);
  if (!issue) throw new NotFoundError("Issue not found");

  if (!forceRefresh && issue.touchedFilesJson) {
    try {
      const cached = JSON.parse(issue.touchedFilesJson) as TouchedFile[];
      return { files: cached, cached: true };
    } catch {}
  }

  const repoPath = (await repo.getProjectRepoPath(issue.projectId, database)) ?? "";

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
  const parsed = extractJsonObject(stdout) as { files?: TouchedFile[] };
  const files: TouchedFile[] = (parsed.files ?? []).slice(0, 12).filter(
    f => f.path && f.reason && ["high", "medium", "low"].includes(f.confidence),
  );

  await repo.updateIssueTouchedFiles(issueId, JSON.stringify(files), database);

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

  const rows = await repo.getIssuesTouchedFiles(issueIds, database);

  const overlap: Record<string, string[]> = {};
  for (const row of rows) {
    if (!row.touchedFilesJson) continue;
    let files: TouchedFile[];
    try { files = JSON.parse(row.touchedFilesJson) as TouchedFile[]; } catch { continue; }
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
  const issueRow = await repo.getIssueTitleDescription(issueId, database);
  if (!issueRow) {
    throw new NotFoundError("Issue not found");
  }
  const { title, description } = issueRow;

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
  const targetIssue = await repo.getIssueBasics(issueId, database);
  if (!targetIssue) throw new NotFoundError("Issue not found");

  // Check if already decomposed (has parent_of dependencies)
  const existingChildDeps = await repo.getParentOfDependency(issueId, database);
  const alreadyDecomposed = existingChildDeps.length > 0;

  // Get recent closed issues for context
  const doneStatusIds = await repo.getTerminalStatusIds(projectId, [...TERMINAL_STATUS_NAMES], database);

  const recentIssues = (await repo.getRecentIssuesWithNode(projectId, database))
    .filter((issue) => isTerminalStatusIdView(issue, new Set(doneStatusIds)))
    .slice(0, 10);

  const projectRow = await repo.getProjectNames(projectId, database);
  const projectName = projectRow?.repoName || projectRow?.name || "unknown project";

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
  const validTypes: DependencyType[] = ["depends_on", "blocked_by", "related_to", "parent_of", "child_of", "coupled_with"];
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
  /** When provided, a Drive record is auto-created with this target and metaIssueId set. */
  driveTarget?: string;
}

export interface ConfirmDecomposeResult {
  createdIssues: Array<{ id: string; issueNumber: number; title: string; tempId: string }>;
  /** The Drive record created for this decomposition, if driveTarget was supplied. */
  driveId?: string;
}

export async function confirmEpicDecomposition(
  input: ConfirmDecomposeInput,
  database: Database,
): Promise<ConfirmDecomposeResult> {
  const { issueId, projectId, children, dependencies } = input;

  // Ensure the parent issue exists
  const parentIssue = await repo.getIssueBasics(issueId, database);
  if (!parentIssue) throw new NotFoundError("Issue not found");

  // Get Backlog status id
  const backlogStatusId = await repo.getStatusIdByName(projectId, "Backlog", database);

  // Get or create epic tag
  let epicTag = await repo.getTagByName("epic", database);
  if (epicTag.length === 0) {
    const tagId = randomUUID();
    await repo.insertTag({
      id: tagId,
      name: "epic",
      color: "#8B5CF6",
      isBuiltin: true,
      createdAt: new Date().toISOString(),
    }, database);
    epicTag = [{ id: tagId }];
  }

  // Create child issues
  const now = new Date().toISOString();
  let nextNumber = await nextIssueNumber(projectId, database);

  const defaultStatusId = backlogStatusId ?? (await repo.getDefaultStatusId(projectId, database));
  if (!defaultStatusId) throw new NotFoundError("No statuses found for project");

  const createdIssues: ConfirmDecomposeResult["createdIssues"] = [];
  const tempIdToIssueId = new Map<string, string>();

  for (const child of children) {
    const childId = randomUUID();
    const issueNumber = nextNumber++;
    await repo.insertChildIssue({
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
    }, database);
    createdIssues.push({ id: childId, issueNumber, title: child.title, tempId: child.tempId });
    tempIdToIssueId.set(child.tempId, childId);
  }

  // Wire dependency edges between children (fromTempId depends_on toTempId)
  for (const dep of dependencies) {
    const fromId = tempIdToIssueId.get(dep.fromTempId);
    const toId = tempIdToIssueId.get(dep.toTempId);
    if (!fromId || !toId) continue;
    await repo.insertIssueDependencySafe({
      id: randomUUID(),
      issueId: fromId,
      dependsOnId: toId,
      type: dep.type,
      createdAt: now,
    }, database);
  }

  // Wire parent_of deps from parent to each child, AND child_of deps from each child back to parent.
  // child_of (child.issueId → dependsOnId=parent) is what reconcileDriveCompletion queries.
  for (const child of createdIssues) {
    await repo.insertIssueDependencySafe({
      id: randomUUID(),
      issueId: issueId,
      dependsOnId: child.id,
      type: "parent_of",
      createdAt: now,
    }, database);
    await repo.insertIssueDependencySafe({
      id: randomUUID(),
      issueId: child.id,
      dependsOnId: issueId,
      type: "child_of",
      createdAt: now,
    }, database);
  }

  // Add epic tag to parent issue (if not already tagged)
  const existingEpicTag = await repo.getIssueTagLink(issueId, epicTag[0].id, database);
  if (existingEpicTag.length === 0) {
    await repo.insertIssueTag({
      id: randomUUID(),
      issueId,
      tagId: epicTag[0].id,
    }, database);
  }

  // Prepend checklist of children to parent description
  const checklist = createdIssues.map(c => `- [ ] #${c.issueNumber} ${c.title}`).join("\n");
  const childrenSection = `## Subtasks (${createdIssues.length})\n${checklist}`;
  const newDescription = parentIssue.description
    ? `${childrenSection}\n\n${parentIssue.description}`
    : childrenSection;
  await repo.updateIssueDescription(issueId, newDescription, now, database);

  let driveId: string | undefined;
  if (input.driveTarget) {
    const drive = await createDrive(
      { projectId, metaIssueId: issueId, target: input.driveTarget },
      database,
    );
    driveId = drive.id;
  }

  return { createdIssues, driveId };
}
