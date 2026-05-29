/**
 * Context Packer — assembles a context primer prepended to the agent's first
 * message via CLAUDE.local.md. The primer surfaces relevant file paths, prior
 * similar closed tickets, recent commits, open-neighbor issues, and a skills
 * hint — all without any external embedding service.
 *
 * Design principles:
 *  - Pure keyword/TF-IDF scoring (no LLM calls, no external services).
 *  - Best-effort: all sections are wrapped in try/catch so failures never
 *    block workspace creation.
 *  - Size-capped: the assembled primer is truncated to ~8 000 chars (~2 K tokens).
 */

import { execFile } from "node:child_process";
import { eq, and, ne, like, or, inArray } from "drizzle-orm";
import { issues, projectStatuses, workspaces, agentSkills } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ContextPackerInput {
  issueId: string;
  issueTitle: string;
  issueDescription: string | null;
  projectId: string;
  repoPath: string;
}

export interface ContextPackerResult {
  primer: string;
  relevantFiles: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MAX_PRIMER_CHARS = 8_000;
const MAX_RELEVANT_FILES = 12;
const MAX_PRIOR_ISSUES = 3;
const MAX_RECENT_COMMITS = 5;

function execGitSafe(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? "" : stdout.toString());
    });
  });
}

/** Extract meaningful tokens from a string (lower-cased, de-duped, no stop words). */
function extractKeywords(text: string): string[] {
  const STOP_WORDS = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "it", "as", "be", "was", "are",
    "this", "that", "i", "we", "you", "he", "she", "they", "do", "does",
    "did", "not", "no", "so", "if", "when", "where", "how", "what", "which",
    "can", "will", "should", "would", "could", "have", "has", "had", "may",
    "its", "our", "into", "about", "up", "out", "also", "all", "any", "more",
    "than", "then", "there", "their", "here", "just", "only", "some", "each",
  ]);
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s_-]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 3 && !STOP_WORDS.has(t)),
    ),
  ];
}

/** Score a file path against a set of keywords (higher = more relevant). */
function scoreFile(filePath: string, keywords: string[]): number {
  const lower = filePath.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) score += 2;
  }
  // Penalise very deep paths (less central) and test/fixture files
  const depth = (filePath.match(/\//g) || []).length;
  score -= Math.max(0, depth - 4) * 0.5;
  if (/\.(test|spec|fixture|mock)\./i.test(filePath)) score -= 1;
  if (/node_modules|dist\/|\.git\//i.test(filePath)) score -= 100;
  return score;
}

/** Get all tracked files in a repo. */
async function listTrackedFiles(repoPath: string): Promise<string[]> {
  const out = await execGitSafe(["ls-files", "--cached"], repoPath);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("node_modules"));
}

/** Get recent git log lines for a set of files. */
async function recentCommitsForFiles(repoPath: string, files: string[], limit: number): Promise<string[]> {
  if (files.length === 0) return [];
  const args = [
    "log",
    `--max-count=${limit}`,
    "--pretty=format:%h %s",
    "--",
    ...files.slice(0, 20),
  ];
  const out = await execGitSafe(args, repoPath);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Simple similarity score between two strings (keyword overlap). */
function titleSimilarity(a: string, keywords: string[]): number {
  const lower = a.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw)).length;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function buildContextPrimer(
  input: ContextPackerInput,
  database: Database,
): Promise<ContextPackerResult> {
  const { issueTitle, issueDescription, projectId, repoPath, issueId } = input;

  const fullText = [issueTitle, issueDescription ?? ""].join(" ");
  const keywords = extractKeywords(fullText);

  // ---- 1. Relevant file paths ------------------------------------------
  let relevantFiles: string[] = [];
  try {
    const allFiles = await listTrackedFiles(repoPath);
    const scored = allFiles
      .map((f) => ({ f, s: scoreFile(f, keywords) }))
      .filter(({ s }) => s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, MAX_RELEVANT_FILES)
      .map(({ f }) => f);
    relevantFiles = scored;
  } catch { /* best-effort */ }

  // ---- 2. Prior art: similar closed issues ----------------------------
  interface IssueSummary { issueNumber: number | null; title: string; description: string | null }
  let priorIssues: IssueSummary[] = [];
  try {
    // Find "Done" status names for this project
    const doneStatuses = await database
      .select({ id: projectStatuses.id })
      .from(projectStatuses)
      .where(
        and(
          eq(projectStatuses.projectId, projectId),
          or(
            like(projectStatuses.name, "%Done%"),
            like(projectStatuses.name, "%Closed%"),
            like(projectStatuses.name, "%Merged%"),
            like(projectStatuses.name, "%Completed%"),
          ),
        ),
      );

    if (doneStatuses.length > 0) {
      const doneIds = doneStatuses.map((s) => s.id);
      const candidates = await database
        .select({ issueNumber: issues.issueNumber, title: issues.title, description: issues.description })
        .from(issues)
        .where(
          and(
            eq(issues.projectId, projectId),
            ne(issues.id, issueId),
            inArray(issues.statusId, doneIds),
          ),
        )
        .limit(100);

      priorIssues = candidates
        .map((c) => ({ ...c, sim: titleSimilarity(c.title + " " + (c.description ?? ""), keywords) }))
        .filter((c) => c.sim > 0)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, MAX_PRIOR_ISSUES);
    }
  } catch { /* best-effort */ }

  // ---- 3. Recent commits touching relevant files ----------------------
  let recentCommits: string[] = [];
  try {
    recentCommits = await recentCommitsForFiles(repoPath, relevantFiles, MAX_RECENT_COMMITS);
  } catch { /* best-effort */ }

  // ---- 4. Open neighbor issues ----------------------------------------
  interface OpenNeighbor { issueNumber: number | null; title: string }
  let openNeighbors: OpenNeighbor[] = [];
  try {
    const fileBaseNames = relevantFiles
      .map((f) => f.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "")
      .filter((n) => n.length >= 4);

    if (fileBaseNames.length > 0) {
      const openStatuses = await database
        .select({ id: projectStatuses.id })
        .from(projectStatuses)
        .where(
          and(
            eq(projectStatuses.projectId, projectId),
            or(
              like(projectStatuses.name, "%Todo%"),
              like(projectStatuses.name, "%In Progress%"),
              like(projectStatuses.name, "%Review%"),
              like(projectStatuses.name, "%Open%"),
              like(projectStatuses.name, "%Backlog%"),
            ),
          ),
        );

      if (openStatuses.length > 0) {
        const openStatusIds = openStatuses.map((s) => s.id);
        const nameConditions = fileBaseNames
          .slice(0, 5)
          .map((n) => or(like(issues.title, `%${n}%`), like(issues.description, `%${n}%`)));

        const orCondition = nameConditions.length === 1
          ? nameConditions[0]!
          : or(...nameConditions as [ReturnType<typeof like>, ...ReturnType<typeof like>[]]);

        const rows = await database
          .select({ issueNumber: issues.issueNumber, title: issues.title })
          .from(issues)
          .where(
            and(
              eq(issues.projectId, projectId),
              ne(issues.id, issueId),
              inArray(issues.statusId, openStatusIds),
              orCondition,
            ),
          )
          .limit(5);
        openNeighbors = rows;
      }
    }
  } catch { /* best-effort */ }

  // ---- 5. Skills hint -------------------------------------------------
  let skillHints: string[] = [];
  try {
    const skills = await database
      .select({ name: agentSkills.name, description: agentSkills.description })
      .from(agentSkills)
      .where(eq(agentSkills.isBuiltin, true));

    skillHints = skills
      .filter((s) => {
        const combined = (s.name + " " + (s.description ?? "")).toLowerCase();
        return keywords.some((kw) => combined.includes(kw));
      })
      .map((s) => `/${s.name}`)
      .slice(0, 4);
  } catch { /* best-effort */ }

  // ---- Assemble primer ------------------------------------------------
  const sections: string[] = [];

  sections.push("<!-- ak-context-primer: auto-generated, gitignored -->");
  sections.push("## Context Primer\n");
  sections.push(
    "This section was assembled automatically to save you from re-discovering known context. Treat it as a starting hint, not gospel.\n",
  );

  if (relevantFiles.length > 0) {
    sections.push("### Likely Relevant Files\n");
    sections.push(relevantFiles.map((f) => `- \`${f}\``).join("\n"));
    sections.push("");
  }

  if (priorIssues.length > 0) {
    sections.push("### Similar Completed Tickets\n");
    for (const p of priorIssues) {
      const num = p.issueNumber != null ? `#${p.issueNumber} ` : "";
      const desc = p.description?.trim().slice(0, 120);
      sections.push(`- **${num}${p.title}**${desc ? ` — ${desc}` : ""}`);
    }
    sections.push("");
  }

  if (recentCommits.length > 0) {
    sections.push("### Recent Commits Touching These Files\n");
    sections.push(recentCommits.map((c) => `- \`${c}\``).join("\n"));
    sections.push("");
  }

  if (openNeighbors.length > 0) {
    sections.push("### Related Open Issues\n");
    sections.push(openNeighbors.map((n) => {
      const num = n.issueNumber != null ? `#${n.issueNumber} ` : "";
      return `- ${num}${n.title}`;
    }).join("\n"));
    sections.push("");
  }

  if (skillHints.length > 0) {
    sections.push("### Potentially Useful Skills\n");
    sections.push(skillHints.join(", "));
    sections.push("");
  }

  let primer = sections.join("\n");

  // Cap size
  if (primer.length > MAX_PRIMER_CHARS) {
    primer = primer.slice(0, MAX_PRIMER_CHARS) + "\n\n_(primer truncated)_\n";
  }

  return { primer, relevantFiles };
}
