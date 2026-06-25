import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isTerminalStatusIdView, TERMINAL_STATUS_NAMES } from "@agentic-kanban/shared";
import type { DependencyType } from "@agentic-kanban/shared/schema";
import type { IssueEstimate } from "@agentic-kanban/shared";
import {
  computeCouplingCandidates,
  couplingCandidatesFor,
  couplingComponents,
  DEFAULT_COUPLING_OVERLAP_THRESHOLD,
  type IssueTouchedFiles,
} from "@agentic-kanban/shared/lib/coupling-overlap";
import { planContraction } from "@agentic-kanban/shared/lib/dependency-graph";
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

/**
 * A propose-only coupling suggestion (#917): two backlog tickets whose AI-predicted
 * touched files overlap above the configured threshold. ADVISORY — never auto-applied.
 * Accepting it (in the dependency-suggestion UI) creates a `coupled_with` edge via the
 * `dependencies/batch` path and may offer the contract action (#914).
 */
export interface CouplingSuggestion {
  /** The OTHER issue this target is coupled with. */
  issueId: string;
  /** Always `coupled_with` — surfaced through the same suggestion shape. */
  type: "coupled_with";
  /** The predicted files both issues share, driving the suggestion. */
  sharedFiles: string[];
  /** Overlap coefficient (0..1). */
  overlapScore: number;
  /** Human-readable rationale shown in the UI. */
  reason: string;
}

export interface AnalyzeDependenciesResult {
  dependencies: Array<{ id: string; type: string; issueId: string; reason: string }>;
  /** Suggestions intentionally NOT created — e.g. a `coupled_with` across an existing sequential edge. */
  flagged?: Array<{ issueId: string; type: string; reason: string }>;
  /**
   * Advisory coupling suggestions from predicted touched-file overlap (#917).
   * Propose-only: nothing here is auto-applied — accepting creates `coupled_with`
   * edges through `dependencies/batch`.
   */
  couplingSuggestions?: CouplingSuggestion[];
  total: number;
}

/** Parse the cached `touched_files_json` blob into a flat list of predicted file paths. */
export function parseTouchedFilePaths(touchedFilesJson: string | null | undefined): string[] {
  if (!touchedFilesJson) return [];
  try {
    const parsed = JSON.parse(touchedFilesJson) as Array<{ path?: unknown }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((f) => (typeof f?.path === "string" ? f.path : ""))
      .filter((p): p is string => Boolean(p));
  } catch {
    return [];
  }
}

/** Read the configurable coupling overlap threshold (0..1), falling back to the default. */
async function getCouplingThreshold(database: Database): Promise<number> {
  const raw = await repo.getPreferenceValue("coupling_overlap_threshold", database);
  if (raw == null || raw === "") return DEFAULT_COUPLING_OVERLAP_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_COUPLING_OVERLAP_THRESHOLD;
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

  // Deterministic coupling signal (#917): compute predicted-touched-file overlap between
  // the target and every other open issue. The high-overlap pairs are (a) appended to the
  // prompt as context so the model can propose `coupled_with` with knowledge of the shared
  // files, and (b) seeded directly as ADVISORY coupling suggestions (propose-only, never
  // auto-created). Threshold is configurable via the `coupling_overlap_threshold` setting.
  const threshold = await getCouplingThreshold(database);
  const touchedFilesByIssue: IssueTouchedFiles[] = openIssues.map((i) => ({
    issueId: i.id,
    files: parseTouchedFilePaths(i.touchedFilesJson),
  }));
  const allCandidates = computeCouplingCandidates(touchedFilesByIssue, { threshold });
  const targetCandidates = couplingCandidatesFor(issueId, allCandidates);

  const idToNumber = new Map(openIssues.map((i) => [i.id, i.issueNumber] as const));

  const issuesSummary = openIssues
    .filter(i => i.id !== issueId)
    .map(i => `  [${i.id}] #${i.issueNumber ?? "?"} ${i.title}${i.description ? `\n    ${i.description.split("\n")[0].slice(0, 100)}` : ""}`)
    .join("\n");

  const overlapContext = targetCandidates.length > 0
    ? `\n\nDeterministic signal — issues sharing predicted touched files with the target (strong coupling candidates; consider proposing "coupled_with"):\n${targetCandidates
        .map((c) => `  [${c.otherIssueId}] #${idToNumber.get(c.otherIssueId) ?? "?"} shares ${c.sharedFiles.length} predicted file(s) (overlap ${(c.overlapScore * 100).toFixed(0)}%): ${c.sharedFiles.join(", ")}`)
        .join("\n")}`
    : "";

  const prompt = `${skillPrompt}

Target issue: [${targetIssue.id}] #${targetIssue.issueNumber ?? "?"} "${targetIssue.title}"
${targetIssue.description ? `Description: ${targetIssue.description}` : ""}

Other open issues on the board (each prefixed with its [id]):
${issuesSummary || "(no other open issues)"}${overlapContext}

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

  // Advisory coupling suggestions (#917) from the deterministic touched-file overlap.
  // Propose-only: nothing is created here. A candidate is suppressed when an edge already
  // exists between the pair in EITHER direction — whether that is a prior `coupled_with`
  // (already coupled), a sequential `depends_on`/`blocked_by` (respect direction: do not
  // suggest contracting across it), or a `coupled_with` the LLM just auto-created this run.
  const candidateOtherIds = targetCandidates.map((c) => c.otherIssueId);
  const candidateEdges = candidateOtherIds.length > 0
    ? await repo.getDependencyEdgesBetween(issueId, candidateOtherIds, database)
    : [];
  const justCreatedTargets = new Set(created.map((c) => c.issueId));

  const couplingSuggestions: CouplingSuggestion[] = [];
  for (const cand of targetCandidates) {
    if (justCreatedTargets.has(cand.otherIssueId)) continue;
    const hasExistingEdge = candidateEdges.some(
      (e) =>
        (e.issueId === issueId && e.dependsOnId === cand.otherIssueId) ||
        (e.issueId === cand.otherIssueId && e.dependsOnId === issueId),
    );
    if (hasExistingEdge) continue;

    const otherNumber = idToNumber.get(cand.otherIssueId);
    couplingSuggestions.push({
      issueId: cand.otherIssueId,
      type: "coupled_with",
      sharedFiles: cand.sharedFiles,
      overlapScore: cand.overlapScore,
      reason: `Strongly coupled — shares ${cand.sharedFiles.length} predicted file(s) (${(cand.overlapScore * 100).toFixed(0)}% overlap) with #${otherNumber ?? "?"}: ${cand.sharedFiles.join(", ")}. Contract into one?`,
    });
  }

  return { dependencies: created, flagged, couplingSuggestions, total: created.length };
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
- Dependency types:
  - "depends_on" — the child needs another child finished first (genuine technical ordering). Default for ordering.
  - "coupled_with" — two children touch the SAME code and are best implemented together (peer coupling, no ordering). DECLARE this when you knowingly split a feature into vertical slices over shared files, so they aren't built as conflicting parallel workspaces (#918). Symmetric — emit once per pair.
- Only add dependencies when there is a genuine ordering requirement (depends_on) or genuine shared-code coupling (coupled_with) — not for mere topical similarity
- Priority: "low", "medium", "high", or "urgent"

Respond ONLY with valid JSON, no markdown, no explanation:
{
  "children": [
    {"tempId": "c1", "title": "...", "description": "...", "priority": "medium"},
    {"tempId": "c2", "title": "...", "description": "...", "priority": "medium"}
  ],
  "dependencies": [
    {"fromTempId": "c2", "toTempId": "c1", "type": "depends_on"},
    {"fromTempId": "c3", "toTempId": "c4", "type": "coupled_with"}
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

// ─────────────────────────────────────────────────────────────────────────────
// Contract — the INVERSE of decomposeEpic (#918).
//
// decomposeEpic SPLITS one epic into a tree of children (forward). contract COLLAPSES
// a coupled component (a connected set of `coupled_with` peers) back into ONE ticket
// (inverse). Both use the same propose→confirm shape: a `contractCoupledComponent`
// generates a proposal (a single merged ticket + the members it would absorb) without
// mutating anything; `confirmContractComponent` applies it — keeping the lowest-numbered
// member as the SURVIVOR (preserving its history/number), folding the others' bodies into
// it, and Cancelling the absorbed members with a pointer back to the survivor.
//
// The monitor's gated auto-contract step (off by default) calls these so coupled tickets
// never fan out into separate conflicting workspaces. Coupling is DISCOVERED with the same
// primitives the analyzer uses — `getCoupledEdges` + `couplingComponents` over the
// `coupled_with` edges agents declared at creation (`create_issues_batch`) or the analyzer
// inferred. Contract lives next to decompose by design; they are a forward/inverse pair.
// ─────────────────────────────────────────────────────────────────────────────

/** A member ticket of a coupled component, as seen by the contract proposal. */
export interface ContractMember {
  id: string;
  issueNumber: number;
  title: string;
  description: string | null;
}

export interface ContractComponentProposal {
  /** The coupled component's members (>= 2), lowest issueNumber first. */
  members: ContractMember[];
  /** The member that would be KEPT (lowest issueNumber) — preserves its number/history. */
  survivorId: string;
  /** Proposed merged title for the survivor. */
  mergedTitle: string;
  /** Proposed merged description (acceptance criteria of all members, deduped). */
  mergedDescription: string;
  /** Why these are coupled — surfaced in the UI / monitor log. */
  reason: string;
}

export interface ContractCoupledResult {
  /** One proposal per coupled component found (largest first). Empty when nothing is coupled. */
  proposals: ContractComponentProposal[];
}

/** Read the configurable minimum component size for an auto-contract suggestion (default 2). */
async function getContractMinComponentSize(database: Database): Promise<number> {
  const raw = await repo.getPreferenceValue("coupling_contract_min_size", database);
  const n = Number(raw);
  return Number.isFinite(n) && n >= 2 ? Math.floor(n) : 2;
}

/**
 * Discover coupled components in a project and PROPOSE contracting each into one ticket.
 * Propose-only — nothing is mutated. `members` whose ticket count is below the configured
 * minimum size are skipped. A component with any OPEN workspace is skipped (never absorb
 * in-flight work). The merged title/description are produced by the model; on any model
 * failure we fall back to a deterministic concatenation so the proposal is always usable.
 */
export async function contractCoupledComponent(
  projectId: string,
  database: Database,
): Promise<ContractCoupledResult> {
  const minSize = await getContractMinComponentSize(database);
  const edges = await repo.getCoupledEdges(projectId, database);
  const components = couplingComponents(edges).filter((c) => c.length >= minSize);
  if (components.length === 0) return { proposals: [] };

  const proposals: ContractComponentProposal[] = [];
  for (const componentIds of components) {
    const rows = await repo.getIssuesForContract(componentIds, database);
    if (rows.length < minSize) continue;
    // Never absorb a component that has in-flight work — let those workspaces finish.
    const openWs = await repo.countOpenWorkspacesForIssues(componentIds, database);
    if (openWs > 0) continue;

    const members: ContractMember[] = rows
      .map((r) => ({ id: r.id, issueNumber: r.issueNumber, title: r.title, description: r.description }))
      .sort((a, b) => a.issueNumber - b.issueNumber);
    const survivor = members[0];

    const { mergedTitle, mergedDescription } = await proposeMergedTicket(members, database);
    proposals.push({
      members,
      survivorId: survivor.id,
      mergedTitle,
      mergedDescription,
      reason: `Coupled component of ${members.length} tickets (#${members.map((m) => m.issueNumber).join(", #")}) — best implemented as one ticket to avoid conflicting parallel workspaces.`,
    });
  }
  return { proposals };
}

/** Deterministic fallback merge — concatenate titles/descriptions when the model is unavailable. */
function deterministicMerge(members: ContractMember[]): { mergedTitle: string; mergedDescription: string } {
  const mergedTitle = members.map((m) => m.title).join(" + ").slice(0, 120);
  const mergedDescription = [
    `Contracted from ${members.length} coupled tickets:`,
    "",
    ...members.map((m) => `### #${m.issueNumber} ${m.title}\n${m.description?.trim() || "(no description)"}`),
  ].join("\n");
  return { mergedTitle, mergedDescription };
}

async function proposeMergedTicket(
  members: ContractMember[],
  database: Database,
): Promise<{ mergedTitle: string; mergedDescription: string }> {
  const prompt = `You are merging several COUPLED kanban tickets (they touch the same code and are best done together) into ONE ticket. Produce a single combined title and description that fully covers all of them, with deduplicated, consolidated acceptance criteria.

Tickets to merge:
${members.map((m) => `#${m.issueNumber} ${m.title}\n${m.description?.trim() || "(no description)"}`).join("\n\n")}

Respond ONLY with valid JSON, no markdown, no explanation:
{"title": "concise combined title under 100 chars", "description": "merged description with consolidated acceptance criteria"}`;

  try {
    const stdout = await invokeClaudePrompt(prompt, { database });
    const parsed = extractJsonObject(stdout) as { title?: string; description?: string };
    const title = parsed.title?.trim();
    const description = parsed.description?.trim();
    if (title && description) return { mergedTitle: title.slice(0, 120), mergedDescription: description };
  } catch (err) {
    console.warn("[issue-ai] contract merge model failed, using deterministic merge:", err instanceof Error ? err.message : err);
  }
  return deterministicMerge(members);
}

export interface ConfirmContractInput {
  projectId: string;
  survivorId: string;
  /** All member ids of the component (must include survivorId). */
  memberIds: string[];
  mergedTitle: string;
  mergedDescription: string;
}

export interface ConfirmContractResult {
  survivorId: string;
  absorbedIds: string[];
}

/**
 * Apply a contract proposal: update the SURVIVOR with the merged title/description, then
 * Cancel every other member (appending a "Contracted into #N" pointer) and drop the now-
 * internal `coupled_with` edges among the component. Idempotent-ish: an already-Cancelled
 * member is simply re-stamped. A member with an open workspace aborts the whole contract
 * (BAD_REQUEST) — the caller must not absorb in-flight work.
 */
export async function confirmContractComponent(
  input: ConfirmContractInput,
  database: Database,
): Promise<ConfirmContractResult> {
  const { projectId, survivorId, memberIds, mergedTitle, mergedDescription } = input;
  const uniqueMembers = [...new Set(memberIds)];
  if (!uniqueMembers.includes(survivorId)) {
    throw new Error("survivorId must be one of memberIds");
  }
  if (uniqueMembers.length < 2) {
    throw new Error("a contract needs at least 2 members");
  }
  const memberRows = await repo.getIssuesForContract(uniqueMembers, database);
  if (memberRows.length !== uniqueMembers.length) {
    throw new NotFoundError("Contract member issue not found");
  }
  const outOfProject = memberRows.find((m) => m.projectId !== projectId);
  if (outOfProject) {
    throw new Error("all contract members must belong to the target project");
  }
  const survivor = memberRows.find((m) => m.id === survivorId);
  if (!survivor) throw new NotFoundError("Survivor issue not found");

  // Refuse to absorb in-flight work.
  const absorbedIds = uniqueMembers.filter((id) => id !== survivorId);
  const openWs = await repo.countOpenWorkspacesForIssues(uniqueMembers, database);
  if (openWs > 0) {
    throw new Error("cannot contract a component with open workspaces");
  }

  const now = new Date().toISOString();
  // 1) Survivor takes the merged title + description.
  await repo.updateIssueTitleDescription(survivorId, mergedTitle, mergedDescription, now, database);

  // 2) Cancel absorbed members with a pointer back to the survivor.
  const cancelledStatusId =
    (await repo.getStatusIdByName(projectId, "Cancelled", database)) ??
    (await repo.getStatusIdByName(projectId, "Done", database));
  for (const id of absorbedIds) {
    await repo.appendIssueDescription(id, `> Contracted into #${survivor.issueNumber} — implemented together as one coupled ticket (#918).`, now, database);
    if (cancelledStatusId) await repo.setIssueStatus(id, cancelledStatusId, now, database);
  }

  // 3) Rewire the dependency graph: the survivor (lead) absorbs the UNION of the component's
  //    EXTERNAL sequential edges, and the now-internal coupled_with edges are dropped. This is
  //    the #916 contraction invariant — apply it via the shared `planContraction` planner so the
  //    edge-inheritance logic stays on one tested implementation (no dangling/duplicate edges).
  const allEdges = await repo.getProjectDependencyEdges(projectId, database);
  const mutations = planContraction(survivorId, uniqueMembers, allEdges);
  for (const m of mutations) {
    if (m.action === "remove") {
      await repo.removeDependencyEdge(m.issueId, m.dependsOnId, m.type as DependencyType, database);
    } else {
      await repo.insertIssueDependencySafe(
        { id: randomUUID(), issueId: m.issueId, dependsOnId: m.dependsOnId, type: m.type as DependencyType, createdAt: now },
        database,
      );
    }
  }

  return { survivorId, absorbedIds };
}
